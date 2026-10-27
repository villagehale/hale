import { type Database, schema } from '@hale/db';
import { and, asc, eq, isNotNull } from 'drizzle-orm';

/**
 * How Hale came to have this parent's number, read from the family's own record (#919).
 * The identity disclosure carries it as a fact when a parent asks "how did you get my
 * number": never a fixed line, never a guess. Null when the record does not say.
 */
export type NumberOrigin =
  /** They texted Hale first (an SMS intake session is the record); `viaQr` when that
   * first text carried a venue QR code. */
  | { kind: 'texted_first'; viaQr: boolean }
  /** Someone in their family added them; `byName` is that person's confirmed name. */
  | { kind: 'added_by_family'; byName: string | null };

/** The fact the writer gets: named parts it words itself, in the reply's language. */
export function numberOriginFact(
  origin: NumberOrigin | null,
): { readonly [part: string]: string } | null {
  if (!origin) return null;
  if (origin.kind === 'texted_first') {
    return origin.viaQr
      ? { how: 'they texted Hale first', from: 'a Hale QR code they scanned' }
      : { how: 'they texted Hale first' };
  }
  return origin.byName
    ? {
        how: 'a member of their family added their number to the family on Hale',
        who: origin.byName,
      }
    : { how: 'a member of their family added their number to the family on Hale' };
}

/** The record, for a parent already in a family. Being added by someone wins: that is
 * how the number reached Hale even if they texted later. */
export async function readNumberOrigin(
  database: Database,
  input: { familyId: string; userId: string },
): Promise<NumberOrigin | null> {
  const [member] = await database
    .select({ invitedBy: schema.familyMembers.invitedByUserId })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, input.familyId),
        eq(schema.familyMembers.userId, input.userId),
      ),
    )
    .limit(1);
  if (member?.invitedBy) {
    const [inviter] = await database
      .select({ name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.id, member.invitedBy))
      .limit(1);
    const name = inviter?.name?.trim();
    return { kind: 'added_by_family', byName: name ? name : null };
  }
  const [session] = await database
    .select({ sourceCode: schema.smsIntakeSessions.sourceCode })
    .from(schema.smsIntakeSessions)
    .where(
      and(
        eq(schema.smsIntakeSessions.userId, input.userId),
        isNotNull(schema.smsIntakeSessions.userId),
      ),
    )
    .orderBy(asc(schema.smsIntakeSessions.createdAt))
    .limit(1);
  if (session) return { kind: 'texted_first', viaQr: session.sourceCode !== null };
  return null;
}
