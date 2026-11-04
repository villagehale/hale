import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { CONNECTOR_PROVIDERS, type ConnectorProvider, type FetchLike } from './google-oauth';
import type { PushEnv } from './google-push-flag';
import { googleJsonClient, stopGooglePushForEndedConnection } from './google-push-runtime';
import type { GoogleJsonClient } from './google-push-watch';
import {
  type ConnectorRevokeVia,
  type EndedConnection,
  type PendingGoogleRevocation,
  clearGoogleRevokePending,
  deleteStaleGoogleRevokePending,
  endGoogleConnections,
  endGoogleConnectionsLocally,
  endOwnerlessGoogleConnections,
  googleGrantsHeldElsewhere,
  listPendingGoogleRevocations,
  loadGoogleRevokePending,
  noteGoogleRevokeAttempt,
  sameGoogleAccount,
} from './store';
import {
  type RevokePendingToken,
  decryptRevokePending,
  revokePendingCustody,
  tokenCustody,
} from './token-vault';

/**
 * VIL-156 · ONE PRIMITIVE for "end this parent's Google access", called by every
 * disconnect path: the Settings action, the API route, the texted disconnect and the
 * co-parent departure (which runs the two halves itself, inside and after its own
 * transaction). Before it, "disconnect" was a DB write and its two external effects
 * lived in callers: the push stop in one route, the Google revoke in none.
 *
 * Google revokes per PROJECT. Its docs: "Revocation removes all OAuth 2.0 scopes
 * previously granted to a project". Every connector shares one OAuth client, so a
 * per-connector revoke is impossible: any Google disconnect ends every Google connector
 * of that parent, and says so.
 *
 * LOCAL FIRST. The parent's keys leave the live column inside one transaction, even if
 * Google is down. One token moves to a pending column that only this file reads. After
 * commit, every push watch is stopped (while the token still works), then each token is
 * revoked at Google. A transient answer leaves the token pending, and the 15-minute
 * connector-sync cron retries through the same function, for at most
 * {@link GOOGLE_REVOKE_PENDING_RETENTION_MS}: {@link expireStaleGoogleRevocations} deletes
 * the token at that age on time alone, whatever the retry did.
 */

export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
/** A revoke that has not answered by then is `unavailable`, and the cron asks again. */
export const GOOGLE_REVOKE_TIMEOUT_MS = 10_000;
/** The deletion window for the pending token: past it, an unanswered revoke is abandoned. */
export const GOOGLE_REVOKE_PENDING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How long one cron run spends asking Google again. The route shares a five-minute
 * deadline with the poll sweep, and a hanging Google costs a full timeout per ask; rows
 * not reached are first in line on the next run. */
export const GOOGLE_REVOKE_RETRY_BUDGET_MS = 60_000;

export type GoogleRevokeResult =
  | { outcome: 'revoked' }
  | { outcome: 'invalid_token' }
  /** Any other 4xx: permanent. */
  | { outcome: 'refused'; status: number }
  /** 5xx, 429, network, timeout: transient. */
  | { outcome: 'unavailable'; status: number | null };

export interface GoogleTokenRevoker {
  revoke(token: string): Promise<GoogleRevokeResult>;
}

class RevokeTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RevokeTimeout()), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

async function errorCode(res: { json: () => Promise<unknown> }): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: unknown } | null;
    return typeof body?.error === 'string' ? body.error : null;
  } catch {
    return null;
  }
}

/** Google's revoke endpoint: POST the token form-encoded; 200 is done, 400 names why. */
export function createGoogleTokenRevoker(
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): GoogleTokenRevoker {
  return {
    async revoke(token) {
      let res: Awaited<ReturnType<FetchLike>>;
      try {
        res = await withTimeout(
          fetchImpl(GOOGLE_REVOKE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token }).toString(),
          }),
          GOOGLE_REVOKE_TIMEOUT_MS,
        );
      } catch {
        return { outcome: 'unavailable', status: null };
      }
      if (res.ok) return { outcome: 'revoked' };
      if (res.status === 429 || res.status >= 500) {
        return { outcome: 'unavailable', status: res.status };
      }
      if (res.status === 400 && (await errorCode(res)) === 'invalid_token') {
        return { outcome: 'invalid_token' };
      }
      return { outcome: 'refused', status: res.status };
    },
  };
}

export interface GoogleDisconnectPorts {
  revoker: GoogleTokenRevoker;
  /** Google's JSON API, for the push stop. */
  google: GoogleJsonClient;
  /** The token endpoint, for the refresh a push stop needs. Never persisted. */
  tokenFetch: FetchLike;
  env: PushEnv;
  now: () => Date;
}

/** Every effect is wired; none is optional (rule #11). */
export function defaultGoogleDisconnectPorts(): GoogleDisconnectPorts {
  return {
    revoker: createGoogleTokenRevoker(),
    google: googleJsonClient,
    tokenFetch: fetch as unknown as FetchLike,
    env: process.env,
    now: () => new Date(),
  };
}

export type { EndedConnection } from './store';

/** Per row. Every terminal value except reconnected_meanwhile writes one system audit row. */
export type GoogleRowOutcome =
  | 'revoked'
  /** invalid_token on a REFRESH token: the grant is already gone. */
  | 'already_invalid'
  /** invalid_token on an ACCESS token: an expired access token proves nothing. */
  | 'access_expired'
  | 'refused'
  | 'no_token'
  | 'decrypt_failed'
  /** Still transient past the retention window: the pending token is deleted. */
  | 'abandoned'
  | 'pending_retry'
  /** The pending token was gone when this settle reached it: a reconnect cleared it, or
   * another settle already did. */
  | 'reconnected_meanwhile';

export interface GoogleSettlement {
  integrationId: string;
  provider: ConnectorProvider;
  push: string;
  google: GoogleRowOutcome;
}

const DONE: ReadonlySet<GoogleRowOutcome> = new Set(['revoked', 'already_invalid']);
const NOT_CONFIRMED: ReadonlySet<GoogleRowOutcome> = new Set([
  'access_expired',
  'refused',
  'no_token',
  'decrypt_failed',
  'abandoned',
]);

const SETTLE_LOG = 'google disconnect: settled';

interface Held {
  row: EndedConnection;
  /** The ciphertext read, for the compare-and-clear. */
  enc: string | null;
  since: Date | null;
  pending: RevokePendingToken | null;
  /** Settled before any revoke: nothing to send Google. */
  early?: GoogleRowOutcome;
  push: string;
}

async function hold(
  db: Database,
  row: EndedConnection,
  ports: GoogleDisconnectPorts,
): Promise<Held> {
  if (row.unrevocable) {
    const stop = await stopGooglePushForEndedConnection(
      db,
      { integrationId: row.id, provider: row.provider, pending: null },
      ports.env,
      ports.google,
      ports.tokenFetch,
    );
    return {
      row,
      enc: null,
      since: null,
      pending: null,
      early: row.unrevocable,
      push: stop.outcome,
    };
  }
  const [stored] = await loadGoogleRevokePending(db, [row.id]);
  if (!stored) {
    return {
      row,
      enc: null,
      since: null,
      pending: null,
      early: 'reconnected_meanwhile',
      push: 'not_attempted',
    };
  }
  let pending: RevokePendingToken | null = null;
  let early: GoogleRowOutcome | undefined;
  try {
    pending = decryptRevokePending(stored.enc);
    if (!pending) early = 'no_token';
  } catch {
    // A key that changed after the disconnect cannot be fixed by waiting.
    early = 'decrypt_failed';
  }
  const stop = await stopGooglePushForEndedConnection(
    db,
    { integrationId: row.id, provider: row.provider, pending },
    ports.env,
    ports.google,
    ports.tokenFetch,
  );
  return {
    row,
    enc: stored.enc,
    since: stored.since,
    pending,
    ...(early ? { early } : {}),
    push: stop.outcome,
  };
}

async function revokeHeld(
  held: Held,
  ports: GoogleDisconnectPorts,
): Promise<{
  outcome: GoogleRowOutcome;
  status?: number | null;
}> {
  if (held.early) return { outcome: held.early };
  const pending = held.pending as RevokePendingToken;
  const answer = await ports.revoker.revoke(pending.token);
  switch (answer.outcome) {
    case 'revoked':
      return { outcome: 'revoked' };
    case 'invalid_token':
      return { outcome: pending.kind === 'refresh' ? 'already_invalid' : 'access_expired' };
    case 'refused':
      return { outcome: 'refused', status: answer.status };
    case 'unavailable': {
      const age = ports.now().getTime() - (held.since as Date).getTime();
      return {
        outcome: age > GOOGLE_REVOKE_PENDING_RETENTION_MS ? 'abandoned' : 'pending_retry',
        status: answer.status,
      };
    }
  }
}

async function record(
  db: Database,
  held: Held,
  result: { outcome: GoogleRowOutcome; status?: number | null },
  now: Date,
): Promise<GoogleRowOutcome> {
  if (result.outcome === 'reconnected_meanwhile') return result.outcome;
  if (result.outcome === 'pending_retry') {
    if (held.enc !== null) await noteGoogleRevokeAttempt(db, held.row.id, held.enc, now);
    return result.outcome;
  }
  const done = DONE.has(result.outcome);
  // The clear and Google's audit row land together: a failed audit write leaves the token
  // pending, so the retry asks again and records it, rather than losing both (rule #6).
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    // Clear only what was read: a reconnect in between already cleared it, and its new
    // grant is not this revoke's to report on.
    if (held.enc !== null && !(await clearGoogleRevokePending(tx, held.row.id, held.enc))) {
      return 'reconnected_meanwhile' as const;
    }
    await tx.insert(schema.auditLog).values({
      familyId: held.row.familyId,
      actor: 'system',
      actionTaken: done
        ? 'integration_google_grant_revoked'
        : 'integration_google_grant_revoke_failed',
      targetTable: 'integrations',
      targetId: held.row.id,
      after: {
        provider: held.row.provider,
        outcome: result.outcome,
        ...(typeof result.status === 'number' ? { status: result.status } : {}),
      },
    });
    return result.outcome;
  });
}

function logSettlement(settlement: GoogleSettlement, status?: number | null): void {
  if (settlement.google === 'pending_retry') {
    console.info(
      { integrationId: settlement.integrationId, status: status ?? null },
      'google disconnect: revoke pending',
    );
  }
  if (NOT_CONFIRMED.has(settlement.google)) {
    console.error(settlement, `google disconnect: ${settlement.google}`);
    return;
  }
  console.info(settlement, SETTLE_LOG);
}

/**
 * The external half, for rows already ended locally. Stops EVERY push watch first, then
 * revokes each pending token. Also the cron's retry. Never throws: the local commit has
 * already happened, and the parent's answer must not fail on Google's side.
 */
export async function settleGoogleRevocations(
  db: Database,
  ended: readonly EndedConnection[],
  ports?: GoogleDisconnectPorts,
): Promise<GoogleSettlement[]> {
  if (ended.length === 0) return [];
  const wired = ports ?? defaultGoogleDisconnectPorts();
  const held: Array<Held | GoogleSettlement> = [];
  for (const row of ended) {
    try {
      held.push(await hold(db, row, wired));
    } catch (err) {
      held.push(failedRow(row, err));
    }
  }
  const settlements: GoogleSettlement[] = [];
  for (const entry of held) {
    if (!('row' in entry)) {
      settlements.push(entry);
      continue;
    }
    try {
      const result = await revokeHeld(entry, wired);
      const google = await record(db, entry, result, wired.now());
      const settlement = {
        integrationId: entry.row.id,
        provider: entry.row.provider,
        push: entry.push,
        google,
      };
      logSettlement(settlement, result.status);
      settlements.push(settlement);
    } catch (err) {
      settlements.push(failedRow(entry.row, err, entry.push));
    }
  }
  return settlements;
}

/** The one allowed catch: a row whose settle threw stays pending, and the rest go on. */
function failedRow(row: EndedConnection, err: unknown, push = 'not_attempted'): GoogleSettlement {
  console.error(
    {
      integrationId: row.id,
      provider: row.provider,
      err: err instanceof Error ? err.name : 'unknown',
    },
    'google disconnect: settle threw - left pending for the retry',
  );
  return { integrationId: row.id, provider: row.provider, push, google: 'pending_retry' };
}

/** What the parent may be told. Each value has its own truthful fact. */
export type GoogleAccessOutcome = 'revoked' | 'pending_retry' | 'not_confirmed';

/**
 * The least-claiming outcome wins. A row a reconnect cleared mid-settle is not
 * confirmed either: Hale did not hear Google end that grant, and will not ask again.
 */
export function googleAccessOutcome(settlements: readonly GoogleSettlement[]): GoogleAccessOutcome {
  if (settlements.every((row) => DONE.has(row.google))) return 'revoked';
  if (
    settlements.some(
      (row) => NOT_CONFIRMED.has(row.google) || row.google === 'reconnected_meanwhile',
    )
  ) {
    return 'not_confirmed';
  }
  return 'pending_retry';
}

export type GoogleDisconnectResult =
  | { status: 'disconnected'; providers: ConnectorProvider[]; google: GoogleAccessOutcome }
  | { status: 'not_connected' };

/**
 * The one door. Ends anything only when the NAMED connector holds keys, checked under a
 * lock in the same transaction: a Calendar-only parent who says "disconnect my gmail"
 * keeps their Calendar. When it does, every Google connector of that parent ends, each
 * with its own `integration_revoked` row, and each is revoked at Google after commit.
 *
 * Throws only when the LOCAL transaction fails; nothing changed then.
 */
export async function disconnectGoogle(
  db: Database,
  input: {
    familyId: string;
    userId: string;
    via: ConnectorRevokeVia;
    named: ConnectorProvider;
  },
  ports?: GoogleDisconnectPorts,
): Promise<GoogleDisconnectResult> {
  const wired = ports ?? defaultGoogleDisconnectPorts();
  const now = wired.now();
  const ended = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const named = await tx
      .select({ id: schema.integrations.id })
      .from(schema.integrations)
      .where(
        and(
          eq(schema.integrations.familyId, input.familyId),
          eq(schema.integrations.userId, input.userId),
          eq(schema.integrations.provider, input.named),
          isNotNull(schema.integrations.oauthTokensEncrypted),
        ),
      )
      .for('update');
    if (named.length === 0) return [];
    const rows = await endGoogleConnections(tx, {
      familyId: input.familyId,
      userId: input.userId,
      now,
    });
    if (rows.length > 0) {
      await tx.insert(schema.auditLog).values(
        rows.map((row) => ({
          familyId: input.familyId,
          actor: input.userId,
          actionTaken: 'integration_revoked',
          targetTable: 'integrations',
          targetId: row.id,
          // The custody the keys HAD, and where the one token now waits for Google:
          // "Hale stopped using its keys" is checkable only if the row says which keys.
          after: {
            provider: row.provider,
            custody: tokenCustody(),
            pending: row.unrevocable ? null : revokePendingCustody(),
            via: input.via,
            named: input.named,
            calendarMirrorsRemoved: row.calendarMirrorsRemoved,
          },
        })),
      );
    }
    return rows;
  });
  if (ended.length === 0) return { status: 'not_connected' };
  const settlements = await settleGoogleRevocations(db, ended, wired);
  return {
    status: 'disconnected',
    providers: CONNECTOR_PROVIDERS.filter((provider) =>
      ended.some((row) => row.provider === provider),
    ),
    google: googleAccessOutcome(settlements),
  };
}

export interface GoogleRevokeRetrySummary {
  attempted: number;
  revoked: number;
  alreadyInvalid: number;
  accessExpired: number;
  refused: number;
  noToken: number;
  decryptFailed: number;
  abandoned: number;
  pending: number;
  reconnectedMeanwhile: number;
}

const SUMMARY_KEY: Record<GoogleRowOutcome, keyof Omit<GoogleRevokeRetrySummary, 'attempted'>> = {
  revoked: 'revoked',
  already_invalid: 'alreadyInvalid',
  access_expired: 'accessExpired',
  refused: 'refused',
  no_token: 'noToken',
  decrypt_failed: 'decryptFailed',
  abandoned: 'abandoned',
  pending_retry: 'pending',
  reconnected_meanwhile: 'reconnectedMeanwhile',
};

/** The cron's half: every row still waiting on Google, through the same settle. */
export async function retryPendingGoogleRevocations(
  db: Database,
  ports?: GoogleDisconnectPorts,
): Promise<GoogleRevokeRetrySummary> {
  const summary: GoogleRevokeRetrySummary = {
    attempted: 0,
    revoked: 0,
    alreadyInvalid: 0,
    accessExpired: 0,
    refused: 0,
    noToken: 0,
    decryptFailed: 0,
    abandoned: 0,
    pending: 0,
    reconnectedMeanwhile: 0,
  };
  const wired = ports ?? defaultGoogleDisconnectPorts();
  const started = wired.now().getTime();
  for (const id of await listPendingGoogleRevocations(db)) {
    if (wired.now().getTime() - started >= GOOGLE_REVOKE_RETRY_BUDGET_MS) break;
    const [row] = await loadGoogleRevokePending(db, [id]);
    if (!row) continue;
    const settlements = await settleGoogleRevocations(
      db,
      [{ id: row.id, familyId: row.familyId, provider: row.provider }],
      wired,
    );
    for (const settlement of settlements) {
      summary.attempted += 1;
      summary[SUMMARY_KEY[settlement.google]] += 1;
    }
  }
  return summary;
}

/** A superseded revoke that Google did not answer: the slot is the new grant's, so Hale
 * cannot ask again, and the old grant is not confirmed ended. */
export type SupersededRevokeOutcome = GoogleRowOutcome | 'superseded';

/**
 * The revoke a connect took out of the pending slot (saveConnection's `superseded`): another
 * Google account's, so asking Google cannot end the grant just given. Asked once, right
 * after the connect commits; only an unanswered ask is `superseded`. One audit row on the
 * integration either way (rule #6). Never throws: the connect has already happened.
 */
export async function settleSupersededGoogleRevoke(
  db: Database,
  superseded: PendingGoogleRevocation,
  ports?: GoogleDisconnectPorts,
): Promise<SupersededRevokeOutcome> {
  const wired = ports ?? defaultGoogleDisconnectPorts();
  const row: EndedConnection = {
    id: superseded.id,
    familyId: superseded.familyId,
    provider: superseded.provider,
  };
  try {
    let pending: RevokePendingToken | null = null;
    let early: GoogleRowOutcome | undefined;
    try {
      pending = decryptRevokePending(superseded.enc);
      if (!pending) early = 'no_token';
    } catch {
      early = 'decrypt_failed';
    }
    const result = await revokeHeld(
      {
        row,
        enc: null,
        since: superseded.since,
        pending,
        ...(early ? { early } : {}),
        push: 'not_attempted',
      },
      wired,
    );
    const outcome: SupersededRevokeOutcome =
      result.outcome === 'pending_retry' || result.outcome === 'abandoned'
        ? 'superseded'
        : result.outcome;
    const done = DONE.has(result.outcome);
    await db.insert(schema.auditLog).values({
      familyId: row.familyId,
      actor: 'system',
      actionTaken: done
        ? 'integration_google_grant_revoked'
        : 'integration_google_grant_revoke_failed',
      targetTable: 'integrations',
      targetId: row.id,
      after: {
        provider: row.provider,
        outcome,
        ...(typeof result.status === 'number' ? { status: result.status } : {}),
      },
    });
    const logged = { integrationId: row.id, provider: row.provider, google: outcome };
    if (done) console.info(logged, SETTLE_LOG);
    else console.error(logged, `google disconnect: ${outcome}`);
    return outcome;
  } catch (err) {
    console.error(
      {
        integrationId: row.id,
        provider: row.provider,
        err: err instanceof Error ? err.name : 'unknown',
      },
      'google disconnect: superseded',
    );
    return 'superseded';
  }
}

/**
 * The pending token's deletion window, enforced on TIME ALONE. The retry's own
 * `abandoned` needs Google to answer `unavailable`; a row whose settle keeps throwing, or
 * that the retry never reaches, would otherwise hold a live token forever. Asks Google
 * nothing, so nothing Google does can starve it. Each deletion and its `abandoned` row
 * land in one transaction (rule #6).
 */
export async function expireStaleGoogleRevocations(
  db: Database,
  now: Date,
): Promise<{ abandoned: number }> {
  const cutoff = new Date(now.getTime() - GOOGLE_REVOKE_PENDING_RETENTION_MS);
  const expired = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    const rows = await deleteStaleGoogleRevokePending(tx, cutoff);
    if (rows.length > 0) {
      await tx.insert(schema.auditLog).values(
        rows.map((row) => ({
          familyId: row.familyId,
          actor: 'system',
          actionTaken: 'integration_google_grant_revoke_failed',
          targetTable: 'integrations',
          targetId: row.id,
          after: { provider: row.provider, outcome: 'abandoned' satisfies GoogleRowOutcome },
        })),
      );
    }
    return rows;
  });
  for (const row of expired) {
    console.error({ provider: row.provider, google: 'abandoned' }, 'google disconnect: abandoned');
  }
  return { abandoned: expired.length };
}

/** A family-erasure row's outcome: a settle outcome, or one of the three local-only ends. */
export type ErasureGoogleOutcome =
  | GoogleRowOutcome
  /** This row's Google account still holds a live grant in another household. Google
   * revokes per account, so a revoke here would end that household's grant too: ended here
   * locally, nothing sent to Google (rule #5). */
  | 'grant_kept_other_household'
  /** A live row with no owner and no account key, so nothing says which Google account a
   * revoke would end: ended locally, never skipped (rule #11). */
  | 'ended_without_owner'
  /** A row whose account is known, while a live grant in another household, of another
   * parent or of none, has no key (a sync overwrote it before the key had its own column),
   * so it may be the same account. Fails closed: ended locally, since Hale's token copy
   * goes either way and a cut grant would end another household's (rule #5). */
  | 'ended_possibly_shared';

export interface ErasureSettlement {
  integrationId: string;
  provider: ConnectorProvider;
  push: string;
  google: ErasureGoogleOutcome;
}

/**
 * Family erasure's half (rights/delete.ts), called BEFORE the family row is deleted: the
 * cascade removes integrations rows, and a row it removes still holding keys, or still
 * holding a pending token, leaves the erased family's grant live at Google.
 *
 * Ends every Google connector of every parent in the family locally (one transaction),
 * then settles those rows and every row an earlier disconnect left pending. A row still
 * `pending_retry` holds the only token that can end its grant, and the cascade would
 * delete it: the caller keeps the family for a later sweep instead, for a bounded wait
 * (the sweep's own bound, rights/delete.ts). Three kinds of row end locally only and are
 * never revoked: one whose Google account still holds a live grant in another household,
 * one with neither an owner nor an account key, and one with a known account while a live
 * grant elsewhere has no key. Any other row with no owner but a known account is revoked
 * like any other. Throws only when the local end fails, which leaves the family standing.
 */
export async function endGoogleForFamilyErasure(
  db: Database,
  familyId: string,
  ports?: GoogleDisconnectPorts,
): Promise<ErasureSettlement[]> {
  const rows = await db
    .select({
      id: schema.integrations.id,
      userId: schema.integrations.userId,
      provider: schema.integrations.provider,
      enc: schema.integrations.oauthTokensEncrypted,
      pending: schema.integrations.googleRevokePendingEncrypted,
      key: schema.integrations.googleAccountKey,
    })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.familyId, familyId),
        inArray(schema.integrations.provider, CONNECTOR_PROVIDERS),
      ),
    );
  const held = rows.filter((row) => row.enc !== null || row.pending !== null);
  if (held.length === 0) return [];
  const elsewhere = await googleGrantsHeldElsewhere(db, { familyId, rows: held });
  const localOnly = new Map<string, ErasureGoogleOutcome>();
  for (const row of held) {
    if (row.userId === null && row.key === null) localOnly.set(row.id, 'ended_without_owner');
    else if (elsewhere.some((other) => sameGoogleAccount(row, other))) {
      localOnly.set(row.id, 'grant_kept_other_household');
    } else if (row.key !== null && elsewhere.some((other) => other.key === null)) {
      localOnly.set(row.id, 'ended_possibly_shared');
    }
  }
  const revocable = held.filter((row) => !localOnly.has(row.id));
  const live = revocable.filter((row) => row.enc !== null);
  const alreadyPending = revocable.filter((row) => row.enc === null);
  const wired = ports ?? defaultGoogleDisconnectPorts();
  const now = wired.now();
  const { ended, endedLocally } = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    // Local-only rows FIRST: one parent can hold a kept account and a revoked one here,
    // and endGoogleConnections ends every row of that parent still holding keys.
    const local = await endGoogleConnectionsLocally(tx, {
      familyId,
      ids: [...localOnly.keys()],
      now,
    });
    const out: EndedConnection[] = [];
    const owners = new Set(live.flatMap((row) => (row.userId === null ? [] : [row.userId])));
    for (const userId of owners) {
      out.push(...(await endGoogleConnections(tx, { familyId, userId, now })));
    }
    out.push(
      ...(await endOwnerlessGoogleConnections(tx, {
        familyId,
        ids: live.filter((row) => row.userId === null).map((row) => row.id),
        now,
      })),
    );
    // The family stands until Google answers, so its trail says what ended (rule #6).
    const trail = [
      ...out.map((row) => ({
        id: row.id,
        provider: row.provider,
        pending: row.unrevocable ? null : revokePendingCustody(),
      })),
      // Neutral here: why a row ended locally can be a fact about one adult's other
      // household, so the reason lives only in the log and the return value.
      ...local.map((row) => ({
        id: row.id,
        provider: row.provider,
        pending: null,
        google: 'ended_locally',
      })),
    ];
    if (trail.length > 0) {
      await tx.insert(schema.auditLog).values(
        trail.map(({ id, ...after }) => ({
          familyId,
          actor: 'system',
          actionTaken: 'integration_ended_for_erasure',
          targetTable: 'integrations',
          targetId: id,
          after: { ...after, custody: tokenCustody() },
        })),
      );
    }
    return { ended: out, endedLocally: local };
  });
  const settlements: ErasureSettlement[] = await settleGoogleRevocations(
    db,
    [
      ...ended,
      ...alreadyPending.map((row) => ({
        id: row.id,
        familyId,
        provider: row.provider as ConnectorProvider,
      })),
    ],
    wired,
  );
  for (const row of endedLocally) {
    // No token is kept, so a push watch cannot be stopped at Google: its row is dropped
    // here and the channel lapses at expiry ('no_token' when one existed).
    const stop = await stopGooglePushForEndedConnection(
      db,
      { integrationId: row.id, provider: row.provider, pending: null },
      wired.env,
      wired.google,
      wired.tokenFetch,
    );
    settlements.push({
      integrationId: row.id,
      provider: row.provider,
      push: stop.outcome,
      google: localOnly.get(row.id) as ErasureGoogleOutcome,
    });
  }
  for (const settlement of settlements) {
    console.info(
      {
        provider: settlement.provider,
        push: settlement.push,
        google:
          settlement.google === 'pending_retry' ? 'erasure_waits_for_google' : settlement.google,
      },
      'google disconnect: family erasure',
    );
  }
  return settlements;
}
