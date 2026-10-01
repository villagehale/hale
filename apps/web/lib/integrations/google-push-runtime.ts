import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { connectorSyncDeps } from '~/lib/cron/connector-sync';
import { emailBlindIndex } from '~/lib/crypto/blind-index';
import { type ConnectorProvider, refreshAccessToken } from './google-oauth';
import { type PushEnv, googlePushSyncEnabled } from './google-push-flag';
import { productionPushDeps } from './google-push-handle';
import { deletePushWatch, loadPushWatch, savePushWatch } from './google-push-store';
import {
  type EnsureWatchOutcome,
  type GoogleJsonClient,
  ensureGooglePushWatch,
  stopGooglePushChannel,
  watchDepsFromEnv,
} from './google-push-watch';
import {
  getSweepableConnectorConnection,
  listActiveConnectorConnections,
  markConnectionError,
  saveConnectionTokensById,
} from './store';
import { ConnectorSyncError } from './sync-error';
import type { OAuthTokens } from './token-vault';
import { decryptTokens } from './token-vault';

/**
 * Production wiring for VIL-401. The poll route renews watches; a push calls the
 * same `syncConnection` the poll uses, so alert behavior is not a second copy.
 * Every path names flag-off instead of doing nothing quietly (rule #11).
 */

const EXPIRY_SKEW_MS = 60_000;

export const googleJsonClient: GoogleJsonClient = {
  async request({ method, url, accessToken, body }) {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { ok: res.ok, status: res.status, json: () => res.json() };
  },
};

export interface PushRenewalSummary {
  skipped?: 'flag_off' | 'renewal_failed';
  opened: number;
  renewed: number;
  notDue: number;
  topicNotConfigured: number;
  failed: number;
}

function emptyRenewal(): PushRenewalSummary {
  return { opened: 0, renewed: 0, notDue: 0, topicNotConfigured: 0, failed: 0 };
}

async function freshAccessToken(
  database: Database,
  integrationId: string,
  tokens: OAuthTokens,
): Promise<string> {
  const expiring =
    tokens.expiresAt !== undefined && tokens.expiresAt - EXPIRY_SKEW_MS <= Date.now();
  if (!expiring) return tokens.accessToken;
  if (!tokens.refreshToken) throw new ConnectorSyncError('no_refresh_token');
  let refreshed: OAuthTokens;
  try {
    refreshed = await refreshAccessToken(tokens.refreshToken);
  } catch {
    throw new ConnectorSyncError('token_refresh_failed');
  }
  const merged: OAuthTokens = {
    ...refreshed,
    refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
  };
  await saveConnectionTokensById(database, integrationId, merged);
  return merged.accessToken;
}

function countOutcome(summary: PushRenewalSummary, outcome: EnsureWatchOutcome): void {
  switch (outcome) {
    case 'opened':
      summary.opened += 1;
      return;
    case 'renewed':
      summary.renewed += 1;
      return;
    case 'not_due':
      summary.notDue += 1;
      return;
    case 'topic_not_configured':
      summary.topicNotConfigured += 1;
      return;
    case 'flag_off':
    case 'not_push_provider':
      return;
    default:
      summary.failed += 1;
  }
}

/** Renew Gmail and Calendar watches that are inside a day of expiry. Flag off does no I/O. */
export async function renewDueGooglePushWatches(
  database: Database,
  env: PushEnv = process.env,
  google: GoogleJsonClient = googleJsonClient,
): Promise<PushRenewalSummary> {
  if (!googlePushSyncEnabled(env)) {
    console.info('google push: renewal skipped, flag_off');
    return { ...emptyRenewal(), skipped: 'flag_off' };
  }
  const summary = emptyRenewal();
  const connections = await listActiveConnectorConnections(database);
  const watchEnv = watchDepsFromEnv(env, google, (email) => emailBlindIndex(email));
  for (const connection of connections) {
    if (connection.provider !== 'gcal' && connection.provider !== 'gmail') continue;
    try {
      const tokens = decryptTokens(connection.enc);
      const accessToken = await freshAccessToken(database, connection.id, tokens);
      const result = await ensureGooglePushWatch({
        integrationId: connection.id,
        provider: connection.provider,
        accessToken,
        now: new Date(),
        env,
        deps: {
          ...watchEnv,
          loadWatch: (id) => loadPushWatch(database, id),
          saveWatch: (id, watch) => savePushWatch(database, id, watch),
        },
      });
      countOutcome(summary, result.outcome);
      if (result.outcome !== 'not_due') {
        console.info(
          { integrationId: connection.id, provider: connection.provider, push: result.outcome },
          'google push: renewal',
        );
      }
    } catch (err) {
      summary.failed += 1;
      const code = err instanceof ConnectorSyncError ? err.code : 'unknown';
      if (err instanceof ConnectorSyncError) {
        await markConnectionError(database, connection.id, code);
      }
      console.error(
        { integrationId: connection.id, provider: connection.provider, code },
        'google push: renewal failed',
      );
    }
  }
  return summary;
}

/**
 * After a connect, open the watch when the flag is on. Flag off returns before any
 * read, so a connect with the flag dark is the connect it was before this existed.
 */
export async function ensurePushWatchAfterConnect(
  database: Database,
  input: {
    familyId: string;
    userId: string;
    provider: ConnectorProvider;
    tokens: OAuthTokens;
  },
  env: PushEnv = process.env,
  google: GoogleJsonClient = googleJsonClient,
): Promise<{ outcome: EnsureWatchOutcome | 'not_found' }> {
  if (!googlePushSyncEnabled(env)) return { outcome: 'flag_off' };
  if (input.provider === 'gdrive') return { outcome: 'not_push_provider' };
  const rows = await database
    .select({ id: schema.integrations.id })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.familyId, input.familyId),
        eq(schema.integrations.userId, input.userId),
        eq(schema.integrations.provider, input.provider),
      ),
    )
    .limit(1);
  const id = rows[0]?.id;
  if (!id) return { outcome: 'not_found' };
  const watchEnv = watchDepsFromEnv(env, google, (email) => emailBlindIndex(email));
  return ensureGooglePushWatch({
    integrationId: id,
    provider: input.provider,
    accessToken: input.tokens.accessToken,
    now: new Date(),
    env,
    deps: {
      ...watchEnv,
      loadWatch: (integrationId) => loadPushWatch(database, integrationId),
      saveWatch: (integrationId, watch) => savePushWatch(database, integrationId, watch),
    },
  });
}

/**
 * Stop Google's channel before the tokens are purged. Flag off does not call Google.
 * The local subscription row is removed only when the flag is on and a row exists;
 * a stop that Google refuses is still named, and the revoke proceeds either way.
 */
export async function stopGooglePushOnDisconnect(
  database: Database,
  familyId: string,
  userId: string,
  provider: ConnectorProvider,
  env: PushEnv = process.env,
  google: GoogleJsonClient = googleJsonClient,
): Promise<{ outcome: string }> {
  if (!googlePushSyncEnabled(env)) return { outcome: 'flag_off' };
  if (provider === 'gdrive') return { outcome: 'not_push_provider' };
  const rows = await database
    .select({
      id: schema.integrations.id,
      enc: schema.integrations.oauthTokensEncrypted,
    })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.familyId, familyId),
        eq(schema.integrations.userId, userId),
        eq(schema.integrations.provider, provider),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return { outcome: 'not_found' };
  const watch = await loadPushWatch(database, row.id);
  let outcome = 'no_watch';
  if (watch && row.enc) {
    try {
      const tokens = decryptTokens(row.enc);
      const accessToken = await freshAccessToken(database, row.id, tokens);
      const stopped = await stopGooglePushChannel({
        provider,
        accessToken,
        channelId: watch.channelId,
        resourceId: watch.resourceId,
        google,
      });
      outcome = stopped.outcome;
    } catch (err) {
      outcome = err instanceof ConnectorSyncError ? err.code : 'stop_failed';
    }
  }
  await deletePushWatch(database, row.id);
  return { outcome };
}

/** One connection, through the same deps the poll sweep builds. */
export async function syncConnectorById(
  database: Database,
  queue: PgBoss,
  integrationId: string,
): Promise<void> {
  const row = await getSweepableConnectorConnection(database, integrationId);
  if (!row) {
    console.info({ integrationId }, 'google push: sync skipped, connection_not_sweepable');
    return;
  }
  const deps = connectorSyncDeps(database, queue);
  let tokens: ReturnType<typeof decryptTokens>;
  try {
    tokens = deps.decryptTokens(row.enc);
  } catch {
    await markConnectionError(database, row.id, 'decrypt_failed');
    return;
  }
  const childNames = await deps.loadChildNames(row.familyId);
  await deps.syncOne({ ...row, tokens }, deps.buildDeps(), childNames);
}

/** The queue is opened only when a verified push actually syncs. */
export function pushWebhookDeps(database: Database, getQueue: () => Promise<PgBoss>) {
  return productionPushDeps(database, async (integrationId) => {
    const queue = await getQueue();
    await syncConnectorById(database, queue, integrationId);
  });
}
