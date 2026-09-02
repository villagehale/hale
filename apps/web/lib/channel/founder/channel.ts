import { type Database, schema } from '@hale/db';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { founderAddress } from '~/lib/auth/founder-signal';
import { decryptString } from '~/lib/crypto/string-cipher';

/**
 * WHO THE FOUNDER IS, AND HOW TO REACH HIM — resolved, never configured twice.
 *
 * THERE ARE NO DIGITS IN THIS FILE and there must never be. The founder is identified by
 * the address the ops signals already use ({@link founderAddress} — FOUNDER_ALERT_EMAIL,
 * falling back to WELCOME_BCC), and his NUMBER is read off his own `parent_channels` row
 * like any other parent's: encrypted at rest, decrypted at the moment of a send, never in
 * an env var and never in source. A hardcoded number would also be a second source of
 * truth for "is this channel still live", and the live row is the only honest answer.
 *
 * ONE READ answers both questions a send needs — the number, and the family whose thread
 * the ping belongs to. Taking the family from the channel row rather than from
 * `family_members` is what stops the two from disagreeing when the founder is a member of
 * more than one household: the thread a message lands in is the thread the channel is
 * enrolled to, by construction.
 */
export interface FounderChannel {
  userId: string;
  /** The family the founder's own SMS channel is enrolled to — the thread the ping lands
   * in, and the family the offer is recorded against. */
  familyId: string;
  phoneE164: string;
}

const CHANNEL_KIND = 'sms';

/**
 * The founder's live SMS channel, or null.
 *
 * Null is an ORDINARY answer, not an error: no address configured, no account for it, no
 * verified channel, or a channel he revoked. Every caller names it as its own outcome
 * (rule #11) rather than treating an absent founder as a failed send.
 */
export async function resolveFounderChannel(database: Database): Promise<FounderChannel | null> {
  const address = founderAddress();
  if (!address) return null;

  const [row] = await database
    .select({
      userId: schema.parentChannels.userId,
      familyId: schema.parentChannels.familyId,
      phoneE164Encrypted: schema.parentChannels.phoneE164Encrypted,
      verifiedAt: schema.parentChannels.verifiedAt,
      revokedAt: schema.parentChannels.revokedAt,
    })
    .from(schema.parentChannels)
    .innerJoin(schema.users, eq(schema.parentChannels.userId, schema.users.id))
    .where(
      and(
        eq(schema.users.email, address),
        eq(schema.parentChannels.kind, CHANNEL_KIND),
        isNotNull(schema.parentChannels.verifiedAt),
        isNull(schema.parentChannels.revokedAt),
      ),
    )
    .limit(1);

  // Defense in depth, the shape `resolveSendablePhone` keeps: re-check the two columns
  // that make a row sendable rather than trusting the predicate that selected it.
  if (!row?.verifiedAt || row.revokedAt !== null) return null;
  return {
    userId: row.userId,
    familyId: row.familyId,
    phoneE164: decryptString(row.phoneE164Encrypted),
  };
}
