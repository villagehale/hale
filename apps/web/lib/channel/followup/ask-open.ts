import { type Database, schema } from '@hale/db';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import { askStillStanding } from '~/lib/channel/checkin/cadence';
import { SENT_STATUSES } from '~/lib/channel/ledger';

/**
 * The template key the activity follow-up ask goes out under (`followup/run.ts`, the
 * `sendFollowup` call for `ask.kind === 'activity'`). It is the discriminator: the intro
 * follow-up shares the `followup` category and asks about something else entirely.
 */
export const ACTIVITY_FOLLOWUP_ASK_TEMPLATE_KEY = 'followup:activity';

/**
 * The dedupe key the ask is claimed under — and the ONLY thing on the outbound row that
 * says WHICH placement Hale asked about.
 *
 * A builder and a reader rather than two template literals, because the capture pass
 * reads back what the sweep wrote: with the format stated twice, renaming it would stop
 * capture silently rather than fail a build.
 */
export function activityFollowupAskDedupeKey(familyEventId: string): string {
  return `${ACTIVITY_FOLLOWUP_ASK_TEMPLATE_KEY}:${familyEventId}`;
}

/** The placement id inside a key this module built, or null for anything else. */
export function familyEventIdFromAskDedupeKey(dedupeKey: string | null): string | null {
  if (!dedupeKey) return null;
  const prefix = `${ACTIVITY_FOLLOWUP_ASK_TEMPLATE_KEY}:`;
  return dedupeKey.startsWith(prefix) ? dedupeKey.slice(prefix.length) || null : null;
}

/**
 * "How did Mia get on at swim?" — OPEN while that is Hale's last word to this parent.
 *
 * WHY IT HAS TO EXIST AT ALL. The ask has been going out since VIL-231 and has never
 * been a listed open question, and `soleOpenKind` reads exactly that list: with one
 * drafted approval and nothing else listed, every open question was of kind `approval`,
 * so a bare "yes" — said thirty seconds after Hale asked how swim went — EXECUTED the
 * calendar write. Consent applied to the wrong question (rule #4). Listing the ask is
 * the whole fix: nothing on this list can resolve it, and that is the point.
 *
 * NO ROW AND NO COLUMN BEHIND IT — `eveningCheckInQuestion`'s pattern, line for line,
 * for the reason that file gives: both facts are already in `channel_messages`, and a
 * stored `question_open` flag would be a second answer every other sender in the product
 * would have to remember to clear.
 *
 * PER PARENT, not per family. The ask is sent to the household's primary parent
 * (`selectFollowupFamilies` joins `role = 'primary_parent'`), and a co-parent who never
 * saw the text is not answering it — which is also what stops their unrelated evening
 * message being read as the household's answer.
 *
 * THE MORNING LAPSES IT, at the same 08:00 local the check-in uses and via the same
 * function. A last-word rule alone would leave the question standing for days against a
 * household Hale happens not to text again, and a Thursday "sure" would be filed as an
 * answer to Monday's swim.
 */
export async function activityFollowupAskOpen(
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
        eq(schema.channelMessages.templateKey, ACTIVITY_FOLLOWUP_ASK_TEMPLATE_KEY),
        // SENT_STATUSES rather than the dedupe key's CONSUMED set: a 'failed' send
        // consumed the key but never reached the phone, and a question nobody was asked
        // is not open.
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  if (!ask) return null;

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

  const timeZone = await parentTimeZone(database, input.parentUserId);
  if (timeZone === null) return null;

  return askStillStanding(ask.createdAt, input.now, timeZone)
    ? { id: ask.id, askedAt: ask.createdAt }
    : null;
}

/** The clock the lapse is read on — the PARENT's, since the question went to their
 * phone. Absent only when the user row is gone, which is not a state this lane acts in. */
async function parentTimeZone(database: Database, parentUserId: string): Promise<string | null> {
  const [row] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId))
    .limit(1);
  return row?.timezone ?? null;
}
