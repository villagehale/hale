import { and, eq, inArray, isNotNull } from 'drizzle-orm';
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
}

function byFamilyUserProvider(familyId: string, userId: string, provider: ConnectorProvider) {
  return and(
    eq(schema.integrations.familyId, familyId),
    eq(schema.integrations.userId, userId),
    eq(schema.integrations.provider, provider),
  );
}

/** Upsert a connection, storing tokens envelope-encrypted, status → active. */
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
  const existing = await database
    .select({ id: schema.integrations.id })
    .from(schema.integrations)
    .where(byFamilyUserProvider(input.familyId, input.userId, input.provider))
    .limit(1);
  const values = {
    familyId: input.familyId,
    userId: input.userId,
    provider: input.provider,
    scopes: input.scopes,
    oauthTokensEncrypted,
    providerMetadata: input.providerMetadata ?? {},
    status: 'active' as const,
    updatedAt: new Date(),
  };
  if (existing[0]) {
    await database
      .update(schema.integrations)
      .set(values)
      .where(eq(schema.integrations.id, existing[0].id));
  } else {
    await database.insert(schema.integrations).values(values);
  }
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
    })
    .from(schema.integrations)
    .where(eq(schema.integrations.familyId, familyId));
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

/** Every ACTIVE connector connection (gcal/gmail/gdrive) with stored tokens — the
 * poll sweep's work list. Revoked/errored rows and rows with purged tokens are
 * excluded, so a disconnected connector is never polled. */
export async function listActiveConnectorConnections(
  database: Database,
): Promise<ActiveConnectorConnection[]> {
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
        eq(schema.integrations.status, 'active'),
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
    tokens: decryptTokens(r.enc as string),
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

/** Disconnect: purge the encrypted tokens and mark revoked (stops sync). */
export async function revokeConnection(
  database: Database,
  familyId: string,
  userId: string,
  provider: ConnectorProvider,
): Promise<void> {
  await database
    .update(schema.integrations)
    .set({ oauthTokensEncrypted: null, status: 'revoked', updatedAt: new Date() })
    .where(byFamilyUserProvider(familyId, userId, provider));
}
