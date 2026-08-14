import { type Database, schema } from '@hale/db';
import { and, eq, inArray } from 'drizzle-orm';
import { UNSUBSCRIBABLE_STREAMS } from './streams';

/**
 * WHERE AN EMAIL REPLY MAY GO — the email twin of `resolveSendablePhone`, and the one
 * place a parent's address becomes a reply address.
 *
 * identity.ts answers WHO wrote to us and says, in as many words, that consent is
 * checked where a send happens rather than at the lookup. This is that place.
 *
 * TWO QUESTIONS, ONE ANSWER. An address to send to, and permission to use it:
 *
 *   THE ADDRESS is `users.email`. There is no `parent_channels` row for email and this
 *   module does not mint one — the app already answers "may we email this person" from
 *   `email_opt_outs`, and a second live-state store for the same question is two readers
 *   that can disagree.
 *
 *   THE PERMISSION is the absence of a WHOLESALE stop. Not any opt-out: a parent who
 *   muted the weekly plan has not asked to be ignored when they write to us, and
 *   answering their own message is solicited by construction (identity.ts). What silences
 *   a reply is the parent having opted out of EVERY stream a typed "unsubscribe" covers —
 *   which is exactly and only what the inbound STOP keyword writes, and what the settings
 *   page's unsubscribe-from-everything produces. That is the email spelling of a texted
 *   STOP, and it earns the same answer: silence, including to a message they sent.
 *
 * READ AT SEND TIME, deliberately. A parent can write "unsubscribe" while an earlier
 * message of theirs is still in C1's queue; the webhook honours the STOP and the queued
 * turn, minutes later, must find the door shut. Checking here rather than at record time
 * is what makes the later of the two facts the one that wins.
 */

/**
 * The address to answer this parent on, or null when there is no address or they have
 * asked us to stop emailing altogether. Null is the router's `unreachable` — the same
 * outcome a revoked SMS channel produces, for the same reason.
 */
export async function resolveSendableEmail(
  database: Database,
  userId: string,
): Promise<string | null> {
  const [user] = await database
    .select({ id: schema.users.id, email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  // Re-checked over the returned row rather than trusted to the predicate — the same
  // defense in depth identity.ts keeps, because the cost of the wrong row here is a
  // family's answer sent to a stranger.
  const address = user?.id === userId ? user.email?.trim() : undefined;
  if (!address) return null;

  return (await hasStoppedEmail(database, userId)) ? null : address;
}

/**
 * Has this parent asked us to stop emailing them, in the only way that means all of it?
 *
 * The predicate is EVERY unsubscribable stream, not any of them, and the distinction is
 * the whole point: partial opt-outs are preferences about Hale's own messages, while the
 * full set is the sentence "stop". Counted over distinct rows because the unique
 * (user, stream) index makes each stream at most one row.
 */
async function hasStoppedEmail(database: Database, userId: string): Promise<boolean> {
  const rows = await database
    .select({ emailType: schema.emailOptOuts.emailType })
    .from(schema.emailOptOuts)
    .where(
      and(
        eq(schema.emailOptOuts.userId, userId),
        inArray(schema.emailOptOuts.emailType, [...UNSUBSCRIBABLE_STREAMS]),
      ),
    );
  const stopped = new Set(rows.map((row) => row.emailType));
  return UNSUBSCRIBABLE_STREAMS.every((stream) => stopped.has(stream));
}
