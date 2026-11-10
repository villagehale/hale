import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { decryptString, encryptString } from '~/lib/crypto/string-cipher';

/** The scope a spend request needs. */
export const LINK_AGENTIC_SCOPE = 'payment_methods.agentic';

/** Stores (or replaces) one parent's Link refresh token, encrypted. */
export async function storeLinkWallet(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    refreshToken: string;
    scope: string;
    linkedAt: Date;
  },
): Promise<{ id: string }> {
  const ciphertext = encryptString(input.refreshToken);
  const [row] = await database
    .insert(schema.familyLinkWallets)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      refreshTokenCiphertext: ciphertext,
      scope: input.scope,
      linkedAt: input.linkedAt,
    })
    .onConflictDoUpdate({
      target: [schema.familyLinkWallets.familyId, schema.familyLinkWallets.parentUserId],
      set: {
        refreshTokenCiphertext: ciphertext,
        scope: input.scope,
        linkedAt: input.linkedAt,
        refreshedAt: null,
      },
    })
    .returning({ id: schema.familyLinkWallets.id });
  if (!row) throw new Error('link wallet upsert returned no row');
  return { id: row.id };
}

export interface LoadedLinkWallet {
  id: string;
  refreshToken: string;
  scope: string;
}

/** Null when this parent has not linked their own Link wallet. */
export async function loadLinkWallet(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<LoadedLinkWallet | null> {
  const [row] = await database
    .select()
    .from(schema.familyLinkWallets)
    .where(
      and(
        eq(schema.familyLinkWallets.familyId, input.familyId),
        eq(schema.familyLinkWallets.parentUserId, input.parentUserId),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    refreshToken: decryptString(row.refreshTokenCiphertext),
    scope: row.scope,
  };
}

/** Link rotates refresh tokens: the new one replaces the old one at once. */
export async function rotateLinkRefreshToken(
  database: Database,
  input: { id: string; refreshToken: string; refreshedAt: Date },
): Promise<void> {
  await database
    .update(schema.familyLinkWallets)
    .set({
      refreshTokenCiphertext: encryptString(input.refreshToken),
      refreshedAt: input.refreshedAt,
    })
    .where(eq(schema.familyLinkWallets.id, input.id));
}

export async function deleteLinkWallet(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<boolean> {
  const rows = await database
    .delete(schema.familyLinkWallets)
    .where(
      and(
        eq(schema.familyLinkWallets.familyId, input.familyId),
        eq(schema.familyLinkWallets.parentUserId, input.parentUserId),
      ),
    )
    .returning({ id: schema.familyLinkWallets.id });
  return rows.length > 0;
}
