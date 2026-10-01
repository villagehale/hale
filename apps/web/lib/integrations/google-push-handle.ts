import type { Database } from '@hale/db';
import { emailBlindIndex } from '~/lib/crypto/blind-index';
import { type PushEnv, googlePushSyncEnabled } from './google-push-flag';
import {
  type CalendarChannelRecord,
  claimPushDebounce,
  loadCalendarChannel,
  loadGmailIntegrations,
  releasePushDebounce,
  takePushPending,
} from './google-push-store';
import {
  type PubSubVerifyResult,
  decodeGmailPushBody,
  readBearerToken,
  readCalendarPushHeaders,
  verifyCalendarPush,
  verifyProductionPubSubToken,
} from './google-push-verify';

/**
 * A verified Google push runs the existing connector sync for that connection.
 *
 * It does not ingest the notification. The alert path, quiet hours, per-sweep caps,
 * title/time/location copy and seeding rules all live inside that sync; this module
 * only decides whether it may start. The Gmail notice's historyId is decoded so a
 * body that is not a mailbox notice is refused, and then discarded — the incremental
 * cursor stays the one the sync already stores.
 */

const MAX_TRAILING_SYNCS = 2;

export interface PushHttpResult {
  status: number;
  body: { status?: string; skipped?: string; error?: string; detail?: string };
}

export interface GooglePushHandleDeps {
  loadCalendarChannel: (channelId: string) => Promise<CalendarChannelRecord | null>;
  loadGmailIntegrations: (mailboxKey: string) => Promise<string[]>;
  claimPushDebounce: (integrationId: string, now: Date) => Promise<'run' | 'coalesce'>;
  takePushPending: (integrationId: string, now: Date) => Promise<boolean>;
  releasePushDebounce: (integrationId: string, now: Date) => Promise<void>;
  /** The existing incremental sync. Receives an integration id and nothing from the push body. */
  syncIntegration: (integrationId: string) => Promise<void>;
  verifyPubSubToken: (token: string) => Promise<PubSubVerifyResult>;
  mailboxKey: (email: string) => string;
}

export function productionPushDeps(
  database: Database,
  syncIntegration: (integrationId: string) => Promise<void>,
): GooglePushHandleDeps {
  return {
    loadCalendarChannel: (channelId) => loadCalendarChannel(database, channelId),
    loadGmailIntegrations: (mailboxKey) => loadGmailIntegrations(database, mailboxKey),
    claimPushDebounce: (integrationId, now) => claimPushDebounce(database, integrationId, now),
    takePushPending: (integrationId, now) => takePushPending(database, integrationId, now),
    releasePushDebounce: (integrationId, now) => releasePushDebounce(database, integrationId, now),
    syncIntegration,
    verifyPubSubToken: (token) => verifyProductionPubSubToken(token),
    mailboxKey: (email) => emailBlindIndex(email.toLowerCase()),
  };
}

export async function handleGooglePushNotification(input: {
  provider: 'gmail' | 'gcal';
  headers: { get(name: string): string | null };
  rawBody: string;
  now?: Date;
  env?: PushEnv;
  deps: GooglePushHandleDeps;
}): Promise<PushHttpResult> {
  const env = input.env ?? process.env;
  if (!googlePushSyncEnabled(env)) {
    console.info({ provider: input.provider }, 'google push: skipped, flag_off');
    return { status: 200, body: { skipped: 'flag_off' } };
  }
  const now = input.now ?? new Date();
  if (input.provider === 'gcal') {
    return handleCalendarPush(input.headers, now, input.deps);
  }
  return handleGmailPush(input.headers, input.rawBody, now, input.deps);
}

async function handleCalendarPush(
  headers: { get(name: string): string | null },
  now: Date,
  deps: GooglePushHandleDeps,
): Promise<PushHttpResult> {
  const presented = readCalendarPushHeaders(headers);
  if (!presented.channelId || !presented.channelToken || !presented.resourceId) {
    return { status: 401, body: { error: 'invalid_signature', detail: 'missing_channel_headers' } };
  }
  const stored = await deps.loadCalendarChannel(presented.channelId);
  if (!stored) return { status: 200, body: { status: 'unbound' } };
  const verified = verifyCalendarPush(presented, stored);
  if (verified.status === 'invalid') {
    return { status: 401, body: { error: 'invalid_signature', detail: verified.reason } };
  }
  return runDebouncedSync(stored.integrationId, now, deps);
}

async function handleGmailPush(
  headers: { get(name: string): string | null },
  rawBody: string,
  now: Date,
  deps: GooglePushHandleDeps,
): Promise<PushHttpResult> {
  const bearer = readBearerToken(headers.get('authorization'));
  if (!bearer) {
    return { status: 401, body: { error: 'invalid_signature', detail: 'missing_bearer' } };
  }
  const verified = await deps.verifyPubSubToken(bearer);
  if (verified.status === 'not_configured') {
    return { status: 501, body: { error: 'provider_not_live', detail: verified.reason } };
  }
  if (verified.status === 'invalid') {
    return { status: 401, body: { error: 'invalid_signature', detail: verified.reason } };
  }
  const notice = decodeGmailPushBody(rawBody);
  if (!notice) return { status: 200, body: { skipped: 'unreadable_payload' } };
  let mailboxKey: string;
  try {
    mailboxKey = deps.mailboxKey(notice.emailAddress);
  } catch (err) {
    console.error(
      { code: err instanceof Error ? err.name : 'unknown' },
      'google push: mailbox key unavailable',
    );
    return { status: 500, body: { error: 'mailbox_key_unavailable' } };
  }
  const integrationIds = await deps.loadGmailIntegrations(mailboxKey);
  if (integrationIds.length === 0) return { status: 200, body: { status: 'unbound' } };
  let synced = 0;
  let debounced = 0;
  for (const integrationId of integrationIds) {
    const result = await runDebouncedSync(integrationId, now, deps);
    if (result.body.status === 'synced') synced += 1;
    else if (result.body.skipped === 'debounced') debounced += 1;
    else if (result.status >= 500) return result;
  }
  if (synced === 0 && debounced > 0) return { status: 200, body: { skipped: 'debounced' } };
  return { status: 200, body: { status: 'synced' } };
}

async function runDebouncedSync(
  integrationId: string,
  now: Date,
  deps: GooglePushHandleDeps,
): Promise<PushHttpResult> {
  const claim = await deps.claimPushDebounce(integrationId, now);
  if (claim === 'coalesce') return { status: 200, body: { skipped: 'debounced' } };
  try {
    await deps.syncIntegration(integrationId);
    let trailing = 0;
    while (trailing < MAX_TRAILING_SYNCS && (await deps.takePushPending(integrationId, now))) {
      trailing += 1;
      await deps.syncIntegration(integrationId);
    }
  } catch (err) {
    console.error(
      { integrationId, code: err instanceof Error ? err.name : 'unknown' },
      'google push: sync failed',
    );
    await deps.releasePushDebounce(integrationId, now);
    return { status: 500, body: { error: 'sync_failed' } };
  }
  return { status: 200, body: { status: 'synced' } };
}
