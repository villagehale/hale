import { type Database, schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';

/**
 * Who sent this email — the email twin of `resolveVerifiedChannelByPhone`, and the
 * single place an address becomes a household.
 *
 * WHAT MAKES THE ANSWER SAFE IS NOT HERE. On the SMS side the lookup itself carries the
 * consent gate: only an ACTIVE, verified, non-revoked `parent_channels` row resolves, so
 * a stopped number is structurally unable to reach the router. Email has no such row —
 * the address lives on `users`, which says nothing about consent — so the proof of
 * identity is the DKIM-aligned verdict the CALLER must establish first (trust.ts), and
 * this function may only be reached once it has. An unauthenticated `From` is a claim,
 * not a sender, and resolving one would hand a stranger a family.
 *
 * WHY NOT A `parent_channels` ROW FOR EMAIL. Because the app already answers "may we
 * email this person" from `email_opt_outs` (the absence of a row IS the consent — see
 * lib/cron/email-compliance.ts). Minting a second live-state store for the same question
 * would create two readers that can disagree, and the one that is wrong is the one that
 * emails a parent who unsubscribed. So identity and consent stay separate questions with
 * one reader each: this module answers WHO, `hasOptedOut` answers MAY WE.
 *
 * Note also that inbound is not outbound. A parent who muted the weekly plan has not
 * asked to be ignored when they write to us; answering their own message is solicited by
 * construction. Consent is therefore checked where a send happens, never here.
 *
 * FAILS CLOSED ON AMBIGUITY. A user in two families is a question this data cannot
 * answer, and filing one household's message under another is a rule #1 disclosure, so
 * ambiguity resolves to null rather than to a guess.
 */

export interface EmailSender {
  userId: string;
  familyId: string;
  /** The sender's role in that family. Returned rather than filtered so the caller
   * owns the parent/caregiver decision — the same split A3 uses. */
  role: string;
}

/**
 * The account and household behind an address, or null when there isn't exactly one.
 *
 * Every predicate is applied TWICE — once in SQL and once over the returned rows. That
 * is the same defense in depth `resolveVerifiedChannelByPhone` documents: routing an
 * inbound to the wrong person is a cross-family disclosure, not merely a wrong reply, so
 * the code does not depend on the query being the only thing that is right.
 */
export async function resolveEmailSender(
  database: Database,
  address: string,
): Promise<EmailSender | null> {
  const wanted = address.trim().toLowerCase();
  if (!wanted) return null;

  const candidates = await database
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${wanted}`)
    .limit(2);

  // A null address must never match: `users.email` is nullable (an SMS-provisioned
  // parent has no address), and an empty probe against a null column is exactly how a
  // stranger would land on a real family.
  const matches = candidates.filter((row) => (row.email ?? '').toLowerCase() === wanted);
  const user = matches.length === 1 ? matches[0] : undefined;
  if (!user) return null;

  const memberships = await database
    .select({
      familyId: schema.familyMembers.familyId,
      userId: schema.familyMembers.userId,
      role: schema.familyMembers.role,
    })
    .from(schema.familyMembers)
    .where(eq(schema.familyMembers.userId, user.id));

  const mine = memberships.filter((row) => row.userId === user.id);
  if (mine.length !== 1) return null;

  const membership = mine[0] as (typeof mine)[number];
  return { userId: user.id, familyId: membership.familyId, role: membership.role };
}
