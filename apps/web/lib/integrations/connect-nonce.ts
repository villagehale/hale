import { and, eq, gt } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';

/**
 * Single-use nonces for the MOBILE connector OAuth flow. The mobile callback has no
 * browser session to bind consent to the minting user (rule #1: the web leg checks
 * session user == bound user), so a mobile connect MINTS a nonce, embeds its id in
 * the signed state, and the callback CONSUMES it. Consumption is a delete that also
 * asserts the row hasn't expired: a state can complete a connection at most once, so
 * a captured/replayed mobile consent url is dead after the first use. This is a
 * REPLAY closer, not a phish closer — the first use by a non-minter still succeeds
 * (see the callback route's accepted-residual note).
 */

/** Mint a nonce bound to a family, returning its id (embedded in the mobile state). */
export async function mintConnectNonce(
  database: Database,
  familyId: string,
  expiresAt: Date,
): Promise<string> {
  const [row] = await database
    .insert(schema.connectorConnectNonces)
    .values({ familyId, expiresAt })
    .returning({ id: schema.connectorConnectNonces.id });
  if (!row) {
    throw new Error('mintConnectNonce: insert returned no row');
  }
  return row.id;
}

/** Consume (delete) an unexpired nonce for a family. Returns true iff a row was
 * burned — false means the nonce was already used, never existed, expired, or is
 * bound to a different family (all → reject the callback). */
export async function consumeConnectNonce(
  database: Database,
  id: string,
  familyId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const deleted = await database
    .delete(schema.connectorConnectNonces)
    .where(
      and(
        eq(schema.connectorConnectNonces.id, id),
        eq(schema.connectorConnectNonces.familyId, familyId),
        gt(schema.connectorConnectNonces.expiresAt, now),
      ),
    )
    .returning({ id: schema.connectorConnectNonces.id });
  return deleted.length > 0;
}
