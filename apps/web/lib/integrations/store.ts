import { type Database, schema } from '@hale/db';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { CONNECTOR_PROVIDERS, type ConnectorProvider, connectorClientSource } from './google-oauth';
import type { ConnectorErrorCode } from './sync-error';
import {
  type OAuthTokens,
  type RevokePendingToken,
  decryptTokens,
  encryptRevokePending,
  encryptTokens,
  tokenCustody,
} from './token-vault';

/**
 * Persistence for connector connections over the existing `integrations` table.
 * Tokens are ALWAYS envelope-encrypted at the boundary (encryptTokens on write,
 * decryptTokens on read) — plaintext OAuth tokens never touch a column. A
 * connection is keyed by (family, user, provider): one parent connects their own
 * Google account, so a household can have each parent's Gmail independently.
 */
export interface ConnectionSummary {
  provider: string;
  status: string;
  scopes: string[];
  lastSyncAt: Date | null;
  /** When this connection was first made — an honest "connected at" for the UI.
   * Always set by listConnections (the row's created_at); optional on the type so a
   * summary can be constructed without it (e.g. a coach-panel fixture). */
  connectedAt?: Date;
  /** The owning parent's user id (null for a family-wide row). Only listConnections
   * sets it — the web loader folds it into `ownedByViewer` and never ships the raw
   * id to the client. */
  userId?: string | null;
  /** Why the last sync failed, as a short PII-free class — null once it recovers,
   * and absent on a row that errored before we recorded reasons. Only listConnections
   * sets it (the Settings surface is the only reader). */
  lastErrorCode?: string | null;
}

/** audit_log.action_taken value for a connector connect (rule #6). */
const AUDIT_CONNECTED = 'integration_connected';

/** WHICH surface a disconnect came from. One verb for both (rule #6's trail reads the
 * same sentence either way); the surface is a field on the row, not a second verb. */
export type ConnectorRevokeVia = 'settings' | 'sms';

function byFamilyUserProvider(familyId: string, userId: string, provider: ConnectorProvider) {
  return and(
    eq(schema.integrations.familyId, familyId),
    eq(schema.integrations.userId, userId),
    eq(schema.integrations.provider, provider),
  );
}

/** Reference the row that would have been inserted, so a conflict overwrites the
 * existing connection with the fresh connect's values (Drizzle's `excluded`). */
function sqlExcluded(column: string) {
  return sql.raw(`excluded.${column}`);
}

/** Upsert a connection, storing tokens envelope-encrypted, status → active. A
 * single ON CONFLICT DO UPDATE on the (family,user,provider) partial unique index
 * — not select-then-insert — so two concurrent connect callbacks can't insert
 * duplicate rows (double polling / double events). The upsert and its immutable
 * connect audit row (rule #6) land in one transaction — the audit row carries
 * provider + family only, never a token or email.
 *
 * Returns `connectId`: THIS connect, identified by that audit row. The integration row
 * is upserted, so its own id says "this parent's Gmail" and cannot tell a first connect
 * from a reconnect; the audit row is written once per connect and can. */
export async function saveConnection(
  database: Database,
  input: {
    familyId: string;
    userId: string;
    provider: ConnectorProvider;
    scopes: string[];
    tokens: OAuthTokens;
    providerMetadata?: Record<string, unknown>;
  },
): Promise<{ connectId: string }> {
  const oauthTokensEncrypted = encryptTokens(input.tokens);
  return database.transaction(async (tx) => {
    // A fresh consent cancels any revoke still waiting from an earlier disconnect, on
    // EVERY row of this parent: Google revokes per project, so a retry that ran after
    // this connect would end the grant the parent just gave (VIL-156).
    await tx
      .update(schema.integrations)
      .set({ googleRevokePendingEncrypted: null, googleRevokePendingSince: null })
      .where(
        and(
          eq(schema.integrations.familyId, input.familyId),
          eq(schema.integrations.userId, input.userId),
          isNotNull(schema.integrations.googleRevokePendingEncrypted),
        ),
      );
    const upserted = await tx
      .insert(schema.integrations)
      .values({
        familyId: input.familyId,
        userId: input.userId,
        provider: input.provider,
        scopes: input.scopes,
        oauthTokensEncrypted,
        providerMetadata: input.providerMetadata ?? {},
        status: 'active' as const,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [
          schema.integrations.familyId,
          schema.integrations.userId,
          schema.integrations.provider,
        ],
        targetWhere: isNotNull(schema.integrations.userId),
        set: {
          scopes: sqlExcluded('scopes'),
          oauthTokensEncrypted: sqlExcluded('oauth_tokens_encrypted'),
          providerMetadata: sqlExcluded('provider_metadata'),
          status: sqlExcluded('status'),
          updatedAt: sqlExcluded('updated_at'),
        },
      })
      .returning({ id: schema.integrations.id });
    const id = upserted[0]?.id;
    if (!id) throw new Error('saveConnection: integrations upsert returned no row');
    const [connect] = await tx
      .insert(schema.auditLog)
      .values({
        familyId: input.familyId,
        actor: input.userId,
        actionTaken: AUDIT_CONNECTED,
        targetTable: 'integrations',
        targetId: id,
        // WHERE the keys now live and WHICH Google project granted them — facts, not
        // prose, so a PIPEDA access request and a residency question are answerable
        // from the row itself. Never a token, never an email, never a client id
        // (rule #1): the custody descriptor names the key and the column only.
        after: {
          provider: input.provider,
          custody: tokenCustody(),
          oauthClient: connectorClientSource(),
        },
      })
      .returning({ id: schema.auditLog.id });
    if (!connect) throw new Error('saveConnection: audit_log insert returned no row');
    return { connectId: connect.id };
  });
}

/**
 * True when another parent in this family already stored this Google account
 * key. The connecting parent is not a match against their own row.
 */
export async function otherParentHoldsGoogleAccount(
  database: Database,
  input: { familyId: string; userId: string; accountKey: string },
): Promise<boolean> {
  const rows = await database
    .select({
      userId: schema.integrations.userId,
      familyId: schema.integrations.familyId,
      providerMetadata: schema.integrations.providerMetadata,
    })
    .from(schema.integrations)
    .where(eq(schema.integrations.familyId, input.familyId));
  return rows.some((row) => {
    if (row.familyId !== input.familyId || !row.userId || row.userId === input.userId) return false;
    const meta = row.providerMetadata;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return false;
    return (meta as Record<string, unknown>).googleAccountKey === input.accountKey;
  });
}

/** The decrypted tokens for an ACTIVE connection, or null if none/revoked. */
export async function getConnectionTokens(
  database: Database,
  familyId: string,
  userId: string,
  provider: ConnectorProvider,
): Promise<OAuthTokens | null> {
  const rows = await database
    .select({ enc: schema.integrations.oauthTokensEncrypted })
    .from(schema.integrations)
    .where(
      and(
        byFamilyUserProvider(familyId, userId, provider),
        eq(schema.integrations.status, 'active'),
      ),
    )
    .limit(1);
  const enc = rows[0]?.enc;
  return enc ? decryptTokens(enc) : null;
}

/** Connection summaries for a family (NO tokens) — for the Settings → Connectors UI. */
export async function listConnections(
  database: Database,
  familyId: string,
): Promise<ConnectionSummary[]> {
  return database
    .select({
      provider: schema.integrations.provider,
      status: schema.integrations.status,
      scopes: schema.integrations.scopes,
      lastSyncAt: schema.integrations.lastSyncAt,
      connectedAt: schema.integrations.createdAt,
      userId: schema.integrations.userId,
      lastErrorCode: schema.integrations.lastErrorCode,
    })
    .from(schema.integrations)
    .where(eq(schema.integrations.familyId, familyId));
}

/** Connection summaries for one PARENT's own connections (NO tokens) — for the mobile
 * connectors surface. Scoped to (family,user) so the list matches the revoke key: a
 * co-parent never sees the other parent's connection (which they can't disconnect),
 * and a provider carries at most one row so the status can't collapse ambiguously. */
export async function listUserConnections(
  database: Database,
  familyId: string,
  userId: string,
): Promise<ConnectionSummary[]> {
  return database
    .select({
      provider: schema.integrations.provider,
      status: schema.integrations.status,
      scopes: schema.integrations.scopes,
      lastSyncAt: schema.integrations.lastSyncAt,
      connectedAt: schema.integrations.createdAt,
    })
    .from(schema.integrations)
    .where(and(eq(schema.integrations.familyId, familyId), eq(schema.integrations.userId, userId)));
}

/** One active connector row the poll sync operates on — tokens decrypted, cursor
 * (providerMetadata) carried so the per-provider sync can resume incrementally. */
export interface ActiveConnectorConnection {
  id: string;
  familyId: string;
  userId: string | null;
  provider: ConnectorProvider;
  providerMetadata: Record<string, unknown>;
  tokens: OAuthTokens;
}

/** A sweepable row as LISTED: the token blob stays opaque (encrypted) here — one
 * tampered/key-rotation-leftover blob must cost its own row inside the sweep's
 * per-connection isolation, never reject the whole work-list. */
export interface SweepableConnectorConnection {
  id: string;
  familyId: string;
  userId: string | null;
  provider: ConnectorProvider;
  providerMetadata: Record<string, unknown>;
  enc: string;
}

/** The connection statuses the poll sweep retries. 'error' is included: a
 * markConnectionError leaves the cursor intact, so re-running from the last good
 * point is safe and lets a transient Google 5xx/429 self-heal (a successful sync
 * flips it back to 'active'). A gmail row parked on google_404 is the same shape —
 * nothing here filters on last_error_code, and the cursor write that ends a
 * successful run clears the code. 'revoked' stays out — its tokens are purged. */
const SWEEPABLE_STATUSES: Array<(typeof schema.integrations.status.enumValues)[number]> = [
  'active',
  'error',
];

/** Every SWEEPABLE connector connection (gcal/gmail/gdrive) with stored tokens —
 * the poll sweep's work list. Active + errored rows are retried; revoked rows and
 * rows with purged tokens are excluded, so a disconnected connector is never
 * polled but a transiently-errored one recovers on its own. */
export async function listActiveConnectorConnections(
  database: Database,
): Promise<SweepableConnectorConnection[]> {
  const rows = await database
    .select({
      id: schema.integrations.id,
      familyId: schema.integrations.familyId,
      userId: schema.integrations.userId,
      provider: schema.integrations.provider,
      providerMetadata: schema.integrations.providerMetadata,
      enc: schema.integrations.oauthTokensEncrypted,
    })
    .from(schema.integrations)
    .where(
      and(
        inArray(schema.integrations.status, SWEEPABLE_STATUSES),
        inArray(schema.integrations.provider, CONNECTOR_PROVIDERS),
        isNotNull(schema.integrations.oauthTokensEncrypted),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    familyId: r.familyId,
    userId: r.userId,
    provider: r.provider as ConnectorProvider,
    providerMetadata: r.providerMetadata,
    enc: r.enc as string,
  }));
}

/** One sweepable gmail/gcal row by id. A push syncs that connection only — it does
 * not load every other family's token blob to find it. */
export async function getSweepableConnectorConnection(
  database: Database,
  id: string,
): Promise<SweepableConnectorConnection | null> {
  const rows = await database
    .select({
      id: schema.integrations.id,
      familyId: schema.integrations.familyId,
      userId: schema.integrations.userId,
      provider: schema.integrations.provider,
      providerMetadata: schema.integrations.providerMetadata,
      enc: schema.integrations.oauthTokensEncrypted,
    })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.id, id),
        inArray(schema.integrations.status, SWEEPABLE_STATUSES),
        inArray(schema.integrations.provider, ['gcal', 'gmail']),
        isNotNull(schema.integrations.oauthTokensEncrypted),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row?.enc) return null;
  return {
    id: row.id,
    familyId: row.familyId,
    userId: row.userId,
    provider: row.provider as ConnectorProvider,
    providerMetadata: row.providerMetadata,
    enc: row.enc,
  };
}

/**
 * The three writers a running sync calls by row id match only a row that still holds
 * keys. A sync already in flight when a disconnect commits would otherwise put refreshed
 * keys back, flip the ended row to 'active', or park it in 'error' with no tokens
 * (VIL-156). Writing nothing to an ended row is the right result, not a skipped effect:
 * the sweep's next run no longer lists it.
 */
function holdingKeys(id: string) {
  return and(eq(schema.integrations.id, id), isNotNull(schema.integrations.oauthTokensEncrypted));
}

/** Advance a connection's sync cursor after a SUCCESSFUL sync: persist the new
 * providerMetadata and stamp lastSyncAt. Only ever called once the batch's events
 * are enqueued, so the cursor can't move past un-emitted items. */
export async function saveConnectionCursor(
  database: Database,
  id: string,
  providerMetadata: Record<string, unknown>,
): Promise<void> {
  await database
    .update(schema.integrations)
    .set({
      providerMetadata,
      lastSyncAt: new Date(),
      status: 'active',
      lastErrorCode: null,
      updatedAt: new Date(),
    })
    .where(holdingKeys(id));
}

/** Persist a refreshed token set (by row id), re-encrypted. The cursor is left
 * untouched — a token refresh is orthogonal to sync progress. */
export async function saveConnectionTokensById(
  database: Database,
  id: string,
  tokens: OAuthTokens,
): Promise<void> {
  await database
    .update(schema.integrations)
    .set({ oauthTokensEncrypted: encryptTokens(tokens), updatedAt: new Date() })
    .where(holdingKeys(id));
}

/** Mark a connection errored after a failed sync, RECORDING why. Deliberately does
 * NOT advance the cursor: the next run re-fetches from the last good cursor, so no
 * item is emitted twice and none is lost. The code is required and PII-free (see
 * sync-error.ts) — a row cannot be parked in 'error' without naming what stopped it
 * (rule #11), which is how one connector stayed broken for fifteen days unread. */
export async function markConnectionError(
  database: Database,
  id: string,
  code: ConnectorErrorCode,
): Promise<void> {
  await database
    .update(schema.integrations)
    .set({ status: 'error', lastErrorCode: code, updatedAt: new Date() })
    .where(holdingKeys(id));
}

/** A connector row a disconnect ended. `unrevocable` names why no token was kept for
 * Google: the row held no usable token, or its keys did not decrypt. */
export interface EndedConnection {
  id: string;
  familyId: string;
  provider: ConnectorProvider;
  unrevocable?: 'no_token' | 'decrypt_failed';
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** The one token Google's revoke needs: the refresh token when there is one. */
function revokeToken(tokens: OAuthTokens): RevokePendingToken | null {
  if (nonEmpty(tokens.refreshToken)) return { kind: 'refresh', token: tokens.refreshToken };
  if (nonEmpty(tokens.accessToken)) return { kind: 'access', token: tokens.accessToken };
  return null;
}

/**
 * End EVERY Google connector this parent holds keys for, inside the caller's
 * transaction (VIL-156). The only writer that nulls `oauth_tokens_encrypted`.
 *
 * Google revokes per project, so one revoke ends Gmail and Calendar together; the rows
 * end together too, rather than leave one holding keys Google has already killed. Each
 * row's keys leave the live column at once. One token moves to the pending column, read
 * only by the revoke (google-disconnect.ts), until Google answers.
 *
 * SCOPE IS THE KEY. The predicate is (family, user): a co-parent's grant is never
 * reached, and a caregiver holds no row to match.
 *
 * THE INVARIANT, written down because two surfaces rest on it: a row whose tokens are
 * gone is a row whose status is 'revoked'. This statement sets both together, and the
 * three sync writers above match only a row that still holds keys, so nothing turns an
 * ended row back into an 'active' or 'error' one. A future path that purged tokens while
 * leaving the status 'error' would leave the Settings card showing a Disconnect button
 * (it renders for any status but 'revoked') over a row no disconnect can match.
 * SWEEPABLE_STATUSES above is the same invariant read the other way.
 *
 * Writes no audit rows: each caller writes its own verb, because the parent's own
 * disconnect and a co-parent's departure are different acts on the same trail.
 */
export async function endGoogleConnections(
  tx: Database,
  input: { familyId: string; userId: string; now: Date },
): Promise<Array<EndedConnection & { calendarMirrorsRemoved: number }>> {
  const live = await tx
    .select({
      id: schema.integrations.id,
      provider: schema.integrations.provider,
      enc: schema.integrations.oauthTokensEncrypted,
    })
    .from(schema.integrations)
    .where(
      and(
        eq(schema.integrations.familyId, input.familyId),
        eq(schema.integrations.userId, input.userId),
        inArray(schema.integrations.provider, CONNECTOR_PROVIDERS),
        isNotNull(schema.integrations.oauthTokensEncrypted),
      ),
    )
    .for('update');
  const ended: EndedConnection[] = [];
  for (const row of live) {
    let pending: string | null = null;
    let unrevocable: EndedConnection['unrevocable'];
    try {
      const token = revokeToken(decryptTokens(row.enc as string));
      if (token) pending = encryptRevokePending(token);
      else unrevocable = 'no_token';
    } catch {
      // The live ciphertext did not decrypt: nothing revocable is left, and the row
      // still ends. Named per row, never folded into a success.
      unrevocable = 'decrypt_failed';
    }
    const updated = await tx
      .update(schema.integrations)
      .set({
        oauthTokensEncrypted: null,
        status: 'revoked',
        googleRevokePendingEncrypted: pending,
        googleRevokePendingSince: pending ? input.now : null,
        updatedAt: input.now,
      })
      .where(holdingKeys(row.id))
      .returning({ id: schema.integrations.id });
    if (updated.length === 0) continue;
    ended.push({
      id: row.id,
      familyId: input.familyId,
      provider: row.provider as ConnectorProvider,
      ...(unrevocable ? { unrevocable } : {}),
    });
  }
  if (ended.length === 0) return [];
  // The integrations row outlives a disconnect, so its ON DELETE CASCADE never reaches
  // the mirrors. They end here; the reminder cron cancels what they had scheduled.
  const mirrors = await tx
    .update(schema.familyEvents)
    .set({ deletedAt: input.now })
    .where(
      and(
        inArray(
          schema.familyEvents.integrationId,
          ended.map((row) => row.id),
        ),
        isNotNull(schema.familyEvents.googleEventId),
        isNull(schema.familyEvents.deletedAt),
      ),
    )
    .returning({ integrationId: schema.familyEvents.integrationId });
  return ended.map((row) => ({
    ...row,
    calendarMirrorsRemoved: mirrors.filter((mirror) => mirror.integrationId === row.id).length,
  }));
}

/** Ids of every ended row still waiting on Google: the retry's work list. */
export async function listPendingGoogleRevocations(database: Database): Promise<string[]> {
  const rows = await database
    .select({ id: schema.integrations.id })
    .from(schema.integrations)
    .where(isNotNull(schema.integrations.googleRevokePendingEncrypted));
  return rows.map((row) => row.id);
}

export interface PendingGoogleRevocation {
  id: string;
  familyId: string;
  provider: ConnectorProvider;
  enc: string;
  since: Date;
}

/** The pending ciphertext for these rows, opaque: decryption is per row, in the revoke. */
export async function loadGoogleRevokePending(
  database: Database,
  ids: readonly string[],
): Promise<PendingGoogleRevocation[]> {
  if (ids.length === 0) return [];
  const rows = await database
    .select({
      id: schema.integrations.id,
      familyId: schema.integrations.familyId,
      provider: schema.integrations.provider,
      enc: schema.integrations.googleRevokePendingEncrypted,
      since: schema.integrations.googleRevokePendingSince,
    })
    .from(schema.integrations)
    .where(
      and(
        inArray(schema.integrations.id, [...ids]),
        isNotNull(schema.integrations.googleRevokePendingEncrypted),
      ),
    );
  return rows.map((row) => ({
    id: row.id,
    familyId: row.familyId,
    provider: row.provider as ConnectorProvider,
    enc: row.enc as string,
    // Written together with the ciphertext, and cleared together with it, everywhere.
    since: row.since as Date,
  }));
}

/**
 * Delete the pending token, but only the one that was read: a reconnect in between has
 * already cleared it (saveConnection), and a second settle must not count twice. True
 * when this call cleared it.
 */
export async function clearGoogleRevokePending(
  database: Database,
  id: string,
  expectedEnc: string,
): Promise<boolean> {
  const cleared = await database
    .update(schema.integrations)
    .set({ googleRevokePendingEncrypted: null, googleRevokePendingSince: null })
    .where(
      and(
        eq(schema.integrations.id, id),
        eq(schema.integrations.googleRevokePendingEncrypted, expectedEnc),
      ),
    )
    .returning({ id: schema.integrations.id });
  return cleared.length > 0;
}
