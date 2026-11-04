import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import type PgBoss from 'pg-boss';
import { connectorSyncDeps } from '~/lib/cron/connector-sync';
import { emailBlindIndex } from '~/lib/crypto/blind-index';
import { type ConnectorProvider, type FetchLike, refreshAccessToken } from './google-oauth';
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
  connectionHoldsKeys,
  getSweepableConnectorConnection,
  listActiveConnectorConnections,
  markConnectionError,
  saveConnectionTokensById,
} from './store';
import { ConnectorSyncError } from './sync-error';
import type { OAuthTokens, RevokePendingToken } from './token-vault';
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
  /** Listed as live, then ended by a disconnect before its watch could be saved. */
  integrationEnded: number;
  /** Of those, the channel just opened that Google did not confirm stopping. */
  orphanStopFailed: number;
  failed: number;
}

function emptyRenewal(): PushRenewalSummary {
  return {
    opened: 0,
    renewed: 0,
    notDue: 0,
    topicNotConfigured: 0,
    integrationEnded: 0,
    orphanStopFailed: 0,
    failed: 0,
  };
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
    case 'integration_ended':
      summary.integrationEnded += 1;
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
      // The listing above can be minutes old by now: a row a disconnect ended since is
      // never sent to Google. The save re-checks under the row lock (savePushWatch).
      if (!(await connectionHoldsKeys(database, connection.id))) {
        countOutcome(summary, 'integration_ended');
        console.info(
          {
            integrationId: connection.id,
            provider: connection.provider,
            push: 'integration_ended',
          },
          'google push: renewal',
        );
        continue;
      }
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
      if (result.stop === 'stop_failed') summary.orphanStopFailed += 1;
      if (result.outcome !== 'not_due') {
        console.info(
          {
            integrationId: connection.id,
            provider: connection.provider,
            push: result.outcome,
            ...(result.stop ? { stop: result.stop } : {}),
          },
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

export type EndedPushStop =
  | 'flag_off'
  | 'not_push_provider'
  | 'no_watch'
  | 'no_token'
  | 'token_refresh_failed'
  | 'stopped'
  | 'stop_failed'
  | 'no_channel';

/** An access token from the held token, never persisted. Null: the refresh failed. */
async function accessTokenFor(
  pending: RevokePendingToken,
  tokenFetch: FetchLike,
): Promise<string | null> {
  if (pending.kind === 'access') return pending.token;
  try {
    return (await refreshAccessToken(pending.token, tokenFetch)).accessToken;
  } catch {
    return null;
  }
}

/**
 * Stop Google's channel for a connection a disconnect has already ended, BEFORE its
 * grant is revoked (google-disconnect.ts runs every stop, then every revoke): after the
 * revoke the stop would be refused and the channel would outlive the grant.
 *
 * It never reads or writes the token column, which is already empty. It uses the one
 * token the revoke is holding, refreshing an access token from it without saving it
 * anywhere. Flag off does not call Google. The local watch row is deleted whenever the
 * flag is on, whatever Google answered: a failed stop is named, and a channel that
 * outlives it lapses at expiry with its pushes dropped (the row is no longer sweepable).
 */
export async function stopGooglePushForEndedConnection(
  database: Database,
  input: {
    integrationId: string;
    provider: ConnectorProvider;
    pending: RevokePendingToken | null;
  },
  env: PushEnv,
  google: GoogleJsonClient,
  tokenFetch: FetchLike,
): Promise<{ outcome: EndedPushStop }> {
  if (!googlePushSyncEnabled(env)) return { outcome: 'flag_off' };
  if (input.provider === 'gdrive') return { outcome: 'not_push_provider' };
  const watch = await loadPushWatch(database, input.integrationId);
  let outcome: EndedPushStop = 'no_watch';
  if (watch && !input.pending) outcome = 'no_token';
  if (watch && input.pending) {
    const accessToken = await accessTokenFor(input.pending, tokenFetch);
    if (accessToken === null) outcome = 'token_refresh_failed';
    else {
      try {
        const stopped = await stopGooglePushChannel({
          provider: input.provider,
          accessToken,
          channelId: watch.channelId,
          resourceId: watch.resourceId,
          google,
        });
        outcome = stopped.outcome;
      } catch {
        outcome = 'stop_failed';
      }
    }
  }
  await deletePushWatch(database, input.integrationId);
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
