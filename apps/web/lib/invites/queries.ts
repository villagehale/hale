import { eq } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';
import { db as defaultDb } from '~/lib/db';

export interface InviteView {
  token: string;
  familyDisplayName: string;
  inviterFirstName: string | null;
  expired: boolean;
  alreadyAccepted: boolean;
}

/**
 * Loads the public, logged-out-safe view of an invite. Surfaces only the family
 * display name and the inviter's FIRST name — never the inviter's email or the
 * invite's target email (rule #1). Returns null for an unknown token so the page
 * renders a single friendly invalid state.
 */
export async function loadInvite(
  token: string,
  database: Database = defaultDb(),
  now: Date = new Date(),
): Promise<InviteView | null> {
  const rows = await database
    .select({
      token: schema.familyInvites.token,
      familyDisplayName: schema.families.displayName,
      inviterName: schema.users.name,
      expiresAt: schema.familyInvites.expiresAt,
      acceptedAt: schema.familyInvites.acceptedAt,
    })
    .from(schema.familyInvites)
    .innerJoin(schema.families, eq(schema.families.id, schema.familyInvites.familyId))
    .innerJoin(schema.users, eq(schema.users.id, schema.familyInvites.createdByUserId))
    .where(eq(schema.familyInvites.token, token))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    token: row.token,
    familyDisplayName: row.familyDisplayName,
    inviterFirstName: firstNameOf(row.inviterName),
    expired: row.expiresAt.getTime() <= now.getTime(),
    alreadyAccepted: row.acceptedAt !== null,
  };
}

function firstNameOf(name: string | null): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}
