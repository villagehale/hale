import { randomBytes, randomUUID } from 'node:crypto';
import { appBaseUrl } from '~/lib/cron/email-compliance';
import { type PushEnv, googlePushSyncEnabled } from './google-push-flag';
import { hashChannelToken, readPubSubTopic } from './google-push-verify';

/**
 * Opening and renewing Google push channels. The webhook only runs the existing
 * sync; this module is the only place that calls `events.watch` and `users.watch`.
 *
 * A Gmail watch response includes a historyId. That value is the mailbox's current
 * cursor, and writing it onto the integration would skip every message that arrived
 * since the last poll. It is deliberately not returned as a cursor.
 */

/** Renew when the channel has this long left, or none stored. */
export const GOOGLE_PUSH_RENEW_BEFORE_MS = 24 * 60 * 60 * 1000;
/** Ask Calendar for a channel that lives just under a week. Google may shorten it. */
export const CALENDAR_WATCH_TTL_MS = 6 * 24 * 60 * 60 * 1000;
/** Gmail's own cap. We do not send it — `users.watch` sets the expiration. */
export const GMAIL_WATCH_MAX_MS = 7 * 24 * 60 * 60 * 1000;

const CALENDAR_WATCH_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events/watch';
const CALENDAR_STOP_URL = 'https://www.googleapis.com/calendar/v3/channels/stop';
const GMAIL_WATCH_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/watch';
const GMAIL_STOP_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/stop';
const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';

export function pushWatchDue(
  expiration: Date | null,
  now: Date,
  renewBeforeMs = GOOGLE_PUSH_RENEW_BEFORE_MS,
): boolean {
  if (expiration === null) return true;
  return expiration.getTime() - now.getTime() <= renewBeforeMs;
}

export function newChannelId(): string {
  return randomUUID();
}

export function newChannelToken(): string {
  return randomBytes(32).toString('base64url');
}

export function calendarPushAddress(env: PushEnv = process.env): string {
  const base = env.APP_URL ?? appBaseUrl();
  return `${base.replace(/\/$/, '')}/api/webhooks/gcal`;
}

export interface GoogleJsonResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export interface GoogleJsonClient {
  request(input: {
    method: 'GET' | 'POST';
    url: string;
    accessToken: string;
    body?: Record<string, unknown>;
  }): Promise<GoogleJsonResponse>;
}

export interface StoredPushWatch {
  provider: 'gcal' | 'gmail';
  expiration: Date | null;
  channelId: string | null;
  resourceId: string | null;
}

export interface SavedPushWatch {
  provider: 'gcal' | 'gmail';
  channelId: string | null;
  resourceId: string | null;
  tokenHash: string | null;
  mailboxKey: string | null;
  topicName: string | null;
  expiration: Date;
}

export type EnsureWatchOutcome =
  | 'flag_off'
  | 'not_push_provider'
  | 'not_due'
  | 'opened'
  | 'renewed'
  | 'topic_not_configured'
  | 'watch_failed'
  | 'mailbox_unreadable'
  | 'stop_failed';

export interface EnsureWatchDeps {
  loadWatch: (integrationId: string) => Promise<StoredPushWatch | null>;
  saveWatch: (integrationId: string, watch: SavedPushWatch) => Promise<void>;
  google: GoogleJsonClient;
  newChannelId: () => string;
  newToken: () => string;
  mailboxKey: (email: string) => string;
  calendarAddress: string;
  topicName: string | null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function expirationDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value);
  if (typeof value !== 'string' || value.length === 0) return null;
  const ms = Number(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

/**
 * Open a watch when there is none, or renew it inside the renewal window.
 * Flag off is a named no-op and does not call Google (rule #11).
 */
export async function ensureGooglePushWatch(input: {
  integrationId: string;
  provider: 'gcal' | 'gmail' | 'gdrive';
  accessToken: string;
  now: Date;
  env?: PushEnv;
  deps: EnsureWatchDeps;
}): Promise<{ outcome: EnsureWatchOutcome }> {
  const env = input.env ?? process.env;
  if (!googlePushSyncEnabled(env)) return { outcome: 'flag_off' };
  if (input.provider === 'gdrive') return { outcome: 'not_push_provider' };

  const existing = await input.deps.loadWatch(input.integrationId);
  if (
    existing &&
    existing.provider === input.provider &&
    !pushWatchDue(existing.expiration, input.now)
  ) {
    return { outcome: 'not_due' };
  }

  if (input.provider === 'gmail') {
    return renewGmailWatch(input.integrationId, input.accessToken, existing !== null, input.deps);
  }
  return renewCalendarWatch(
    input.integrationId,
    input.accessToken,
    input.now,
    existing,
    input.deps,
  );
}

async function renewGmailWatch(
  integrationId: string,
  accessToken: string,
  hadWatch: boolean,
  deps: EnsureWatchDeps,
): Promise<{ outcome: EnsureWatchOutcome }> {
  if (!deps.topicName) return { outcome: 'topic_not_configured' };
  const profile = await deps.google.request({
    method: 'GET',
    url: GMAIL_PROFILE_URL,
    accessToken,
  });
  if (!profile.ok) return { outcome: 'mailbox_unreadable' };
  const profileBody = (await profile.json()) as { emailAddress?: unknown };
  const email = readString(profileBody.emailAddress);
  if (!email) return { outcome: 'mailbox_unreadable' };

  const watched = await deps.google.request({
    method: 'POST',
    url: GMAIL_WATCH_URL,
    accessToken,
    body: { topicName: deps.topicName },
  });
  if (!watched.ok) return { outcome: 'watch_failed' };
  // `historyId` on this body is the mailbox's current cursor. It is not read:
  // persisting it would skip mail that arrived since the last poll.
  const body = (await watched.json()) as { expiration?: unknown };
  const expiration = expirationDate(body.expiration);
  if (!expiration) return { outcome: 'watch_failed' };
  await deps.saveWatch(integrationId, {
    provider: 'gmail',
    channelId: null,
    resourceId: null,
    tokenHash: null,
    mailboxKey: deps.mailboxKey(email.toLowerCase()),
    topicName: deps.topicName,
    expiration,
  });
  return { outcome: hadWatch ? 'renewed' : 'opened' };
}

async function renewCalendarWatch(
  integrationId: string,
  accessToken: string,
  now: Date,
  existing: StoredPushWatch | null,
  deps: EnsureWatchDeps,
): Promise<{ outcome: EnsureWatchOutcome }> {
  if (!deps.calendarAddress) return { outcome: 'watch_failed' };
  const channelId = deps.newChannelId();
  const token = deps.newToken();
  const watched = await deps.google.request({
    method: 'POST',
    url: CALENDAR_WATCH_URL,
    accessToken,
    body: {
      id: channelId,
      type: 'web_hook',
      address: deps.calendarAddress,
      token,
      expiration: now.getTime() + CALENDAR_WATCH_TTL_MS,
    },
  });
  if (!watched.ok) return { outcome: 'watch_failed' };
  const body = (await watched.json()) as { resourceId?: unknown; expiration?: unknown };
  const resourceId = readString(body.resourceId);
  const expiration =
    expirationDate(body.expiration) ?? new Date(now.getTime() + CALENDAR_WATCH_TTL_MS);
  if (!resourceId) return { outcome: 'watch_failed' };
  await deps.saveWatch(integrationId, {
    provider: 'gcal',
    channelId,
    resourceId,
    tokenHash: hashChannelToken(token),
    mailboxKey: null,
    topicName: null,
    expiration,
  });
  if (existing?.channelId && existing.resourceId && existing.channelId !== channelId) {
    const stopped = await deps.google.request({
      method: 'POST',
      url: CALENDAR_STOP_URL,
      accessToken,
      body: { id: existing.channelId, resourceId: existing.resourceId },
    });
    if (!stopped.ok) return { outcome: 'stop_failed' };
  }
  return { outcome: existing ? 'renewed' : 'opened' };
}

/** Best-effort stop. A failure is named; the caller still revokes the local row. */
export async function stopGooglePushChannel(input: {
  provider: 'gcal' | 'gmail';
  accessToken: string;
  channelId: string | null;
  resourceId: string | null;
  google: GoogleJsonClient;
}): Promise<{ outcome: 'stopped' | 'stop_failed' | 'no_channel' }> {
  if (input.provider === 'gmail') {
    const res = await input.google.request({
      method: 'POST',
      url: GMAIL_STOP_URL,
      accessToken: input.accessToken,
    });
    return { outcome: res.ok ? 'stopped' : 'stop_failed' };
  }
  if (!input.channelId || !input.resourceId) return { outcome: 'no_channel' };
  const res = await input.google.request({
    method: 'POST',
    url: CALENDAR_STOP_URL,
    accessToken: input.accessToken,
    body: { id: input.channelId, resourceId: input.resourceId },
  });
  return { outcome: res.ok ? 'stopped' : 'stop_failed' };
}

export function watchDepsFromEnv(
  env: PushEnv,
  google: GoogleJsonClient,
  mailboxKey: (email: string) => string,
): Pick<
  EnsureWatchDeps,
  'google' | 'newChannelId' | 'newToken' | 'mailboxKey' | 'calendarAddress' | 'topicName'
> {
  return {
    google,
    newChannelId,
    newToken: newChannelToken,
    mailboxKey,
    calendarAddress: calendarPushAddress(env),
    topicName: readPubSubTopic(env),
  };
}
