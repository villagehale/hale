import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';
import { CONNECTOR_PROVIDERS, type ConnectorProvider } from './google-oauth';
import { decryptTokens, encryptTokens, type OAuthTokens } from './token-vault';

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
}

/** audit_log.action_taken values for a connector connect/disconnect (rule #6). */
const AUDIT_CONNECTED = 'integration_connected';
const AUDIT_REVOKED = 'integration_revoked';

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
 * provider + family only, never a token or email. */
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
): Promise<void> {
  const oauthTokensEncrypted = encryptTokens(input.tokens);
  await database.transaction(async (tx) => {
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
    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: AUDIT_CONNECTED,
      targetTable: 'integrations',
      targetId: upserted[0]?.id,
      after: { provider: input.provider },
    });
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
      and(byFamilyUserProvider(familyId, userId, provider), eq(schema.integrations.status, 'active')),
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
    .where(
      and(
        eq(schema.integrations.familyId, familyId),
        eq(schema.integrations.userId, userId),
      ),
    );
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
 * flips it back to 'active'). 'revoked' stays out — its tokens are purged. */
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
    .set({ providerMetadata, lastSyncAt: new Date(), status: 'active', updatedAt: new Date() })
    .where(eq(schema.integrations.id, id));
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
    .where(eq(schema.integrations.id, id));
}

/** Mark a connection errored after a failed sync. Deliberately does NOT advance
 * the cursor: the next run re-fetches from the last good cursor, so no item is
 * emitted twice and none is lost. */
export async function markConnectionError(database: Database, id: string): Promise<void> {
  await database
    .update(schema.integrations)
    .set({ status: 'error', updatedAt: new Date() })
    .where(eq(schema.integrations.id, id));
}

/** Disconnect: purge the encrypted tokens and mark revoked (stops sync). The
 * revoke and its immutable audit row (rule #6) land in one transaction; the audit
 * row carries provider + family only. Returns the number of rows revoked, so a
 * no-op revoke (no matching row — nothing was disconnected, no audit row written)
 * is surfaced to the caller as 'not_found' rather than a false 'revoked'. */
export async function revokeConnection(
  database: Database,
  familyId: string,
  userId: string,
  provider: ConnectorProvider,
): Promise<number> {
  return database.transaction(async (tx) => {
    const revoked = await tx
      .update(schema.integrations)
      .set({ oauthTokensEncrypted: null, status: 'revoked', updatedAt: new Date() })
      .where(byFamilyUserProvider(familyId, userId, provider))
      .returning({ id: schema.integrations.id });
    if (revoked.length === 0) return 0;
    await tx.insert(schema.auditLog).values({
      familyId,
      actor: userId,
      actionTaken: AUDIT_REVOKED,
      targetTable: 'integrations',
      targetId: revoked[0]?.id,
      after: { provider },
    });
    return revoked.length;
  });
}
