import { type Database, schema } from '@hale/db';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import { DAYCARE_FOLLOWUP_TEMPLATE_KEY } from './run';

/**
 * IS THE DAYCARE FOLLOW-UP STILL OPEN? — derived from the message ledger, like the
 * evening check-in's and the weekday-care ask's.
 *
 * IT EXISTS BECAUSE `sendFollowup` REGISTERS NOTHING. Every message this lane sends is
 * a QUESTION, and the row it writes is a ledger row and nothing else — no commitment,
 * no offer, no open question. The `activity_followup` kind hides that: it is sourced
 * from the COMMITMENT the coach made ("I'll come back to you"), which happens to be
 * open in the common case, and the calendar-driven activity ask never touches it.
 *
 * So without this, "how is daycare going?" plus one pending approval plus a bare "yes"
 * executes the draft: `questions.every(q => q.kind === 'approval')` is true,
 * `mayClaimBareWord` returns true, and the approval handler acts on a word that was
 * answering something else entirely. That is not a hypothetical — it is the shape of a
 * live incident on another kind.
 *
 * (The same gap is still open for `followup:activity`. It is one Linear ticket, not a
 * change bundled into this one.)
 */

/** Long enough that an answer the next lunchtime still lands, short enough that a reply
 * three days later is a new conversation. The no-newer-outbound rule does the real work;
 * this is the backstop for a household Hale happens not to text again. */
export const DAYCARE_FOLLOWUP_QUESTION_TTL_MS = 48 * 3_600_000;

/** Per PARENT: the ask went to the one seat this lane sends to. */
export async function daycareFollowupQuestion(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
): Promise<{ id: string; askedAt: Date } | null> {
  const [ask] = await database
    .select({ id: schema.channelMessages.id, createdAt: schema.channelMessages.createdAt })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        // The TEMPLATE key, which carries no child — the DEDUPE key does
        // (`followup:daycare:<childId>`), and querying for that one would match nothing.
        eq(schema.channelMessages.templateKey, DAYCARE_FOLLOWUP_TEMPLATE_KEY),
        // A question nobody was asked is not open, so `failed` is excluded here even
        // though it consumed the dedupe key.
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  if (!ask) return null;

  if (input.now.getTime() - ask.createdAt.getTime() > DAYCARE_FOLLOWUP_QUESTION_TTL_MS) {
    return null;
  }

  const [newer] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
        gt(schema.channelMessages.createdAt, ask.createdAt),
      ),
    )
    .limit(1);
  if (newer) return null;

  return { id: ask.id, askedAt: ask.createdAt };
}
