import { type Database, schema } from '@hale/db';
import { and, desc, eq, gt, inArray } from 'drizzle-orm';
import {
  WEEKDAY_AFTER_SCHOOL_TEMPLATE_KEY,
  WEEKDAY_BREAK_TEMPLATE_KEY,
  WEEKDAY_CARE_ASK_TEMPLATE_KEY,
} from '~/lib/care/weekday';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import type { WeekdaySearchPrompt } from '~/lib/channel/nudge/weekday-care-copy';
import { parseWeekdayAskKey } from './key';

/**
 * IS THE WEEKDAY-CARE QUESTION STILL OPEN? — derived, with no row and no column of its
 * own, the way the evening check-in's is.
 *
 * Both facts this needs are already in `channel_messages`: when the ask went out, and
 * whether anything has gone out since. A stored `question_open` flag would be a second
 * answer to a question the ledger already answers, and every other sender in the
 * product would have to remember to clear it.
 *
 * THE TTL IS 48 HOURS, and it is a number rather than "a TTL". The evening check-in's
 * reader cannot be copied here: it closes at 08:00 the next morning because an evening
 * question is about THAT evening and is stale by breakfast. A weekday-care question is
 * about a household arrangement that does not change overnight, so the same clause
 * would throw away a perfectly good answer sent at lunchtime the next day. The
 * no-newer-outbound rule does the real work either way — the moment anything else goes
 * out, the question closes regardless of the clock.
 *
 * `SENT_STATUSES` rather than the dedupe key's CONSUMED set, and the difference is
 * deliberate: a `failed` send consumed the key (so the family is never asked twice) but
 * never reached a phone, and a question nobody was asked is not open.
 */

export const WEEKDAY_CARE_QUESTION_TTL_MS = 48 * 3_600_000;

export type WeekdayCareQuestion =
  | {
      /** The ask's own `channel_messages` row — the id the open-question list carries. */
      id: string;
      askedAt: Date;
      scope: 'legacy_care';
      /** WHO it asked about, parsed back out of the ask's own dedupe key. */
      childId: string;
    }
  | {
      id: string;
      askedAt: Date;
      scope: 'search';
      prompt: WeekdaySearchPrompt;
      eventKey: string | null;
    };

/** Per PARENT, not per family: the question went to one phone, and a co-parent who
 * never saw it is not the person it was put to. */
export async function weekdayCareQuestion(
  database: Database,
  input: { familyId: string; parentUserId: string; now: Date },
): Promise<WeekdayCareQuestion | null> {
  const [ask] = await database
    .select({
      id: schema.channelMessages.id,
      createdAt: schema.channelMessages.createdAt,
      dedupeKey: schema.channelMessages.dedupeKey,
    })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.familyId, input.familyId),
        eq(schema.channelMessages.parentUserId, input.parentUserId),
        eq(schema.channelMessages.direction, 'out'),
        inArray(schema.channelMessages.templateKey, [
          WEEKDAY_CARE_ASK_TEMPLATE_KEY,
          WEEKDAY_AFTER_SCHOOL_TEMPLATE_KEY,
          WEEKDAY_BREAK_TEMPLATE_KEY,
        ]),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    )
    .orderBy(desc(schema.channelMessages.createdAt))
    .limit(1);
  if (!ask) return null;

  if (input.now.getTime() - ask.createdAt.getTime() > WEEKDAY_CARE_QUESTION_TTL_MS) return null;

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

  const parsed = parseWeekdayAskKey(ask.dedupeKey);
  if (parsed === null) return null;
  if (parsed.scope === 'search') {
    return {
      id: ask.id,
      askedAt: ask.createdAt,
      scope: 'search',
      prompt: parsed.prompt,
      eventKey: parsed.eventKey,
    };
  }
  return { id: ask.id, askedAt: ask.createdAt, scope: 'legacy_care', childId: parsed.childId };
}
