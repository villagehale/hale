import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { modelReadSweepEnabled } from '~/lib/channel/meaning-screen/flag';
import { type MeaningScreen, sharedMeaningScreen } from '~/lib/channel/meaning-screen/read';
import {
  type GroupActivityDecision,
  groupDecisionSyncOpen,
  queueGroupActivityDecision,
} from './family-outbound';

/**
 * A complete kid-logistics decision a parent typed in 1:1, read for its meaning.
 *
 * The model reads it (`activity_decision` on the meaning screen), in whatever words and
 * language the parent used. There is no word list and no sentence template behind it:
 * the English and French pickers that matched "picked X for Y, DAY at TIME" are gone
 * (VIL-723, folded into the MODEL_READ_SWEEP_ENABLED screen). A question, a maybe, a
 * registration outcome or a pick with no day and time is not a decision.
 *
 * Off (MODEL_READ_SWEEP_ENABLED not exactly `true`), nothing is read and nothing is
 * queued, and the outcome says so. An unread screen queues nothing. The read is paid
 * for only once the cheap reads say a decision could land: a claimed group to sync into
 * that this text did not arrive in, and a child on the family. The kid the model names
 * must still be one of this family's children before anything is queued.
 */

export type ActivityDecisionSkip =
  | 'sweep_off'
  | 'no_group'
  | 'no_children'
  | 'unread'
  | 'not_a_decision'
  | 'unknown_kid'
  | 'not_queued';

export type ActivityDecisionOutcome =
  | { status: 'queued' }
  | { status: 'skipped'; reason: ActivityDecisionSkip };

/** The screen's reading as a decision, or null when it read none (or did not read). */
export async function readActivityDecision(
  screen: MeaningScreen,
  body: string,
): Promise<GroupActivityDecision | null | 'unread'> {
  const reading = await screen.read({ screen: 'activity_decision', text: body });
  if (!reading) return 'unread';
  if (
    reading.decision === 'picked' &&
    reading.activity &&
    reading.kid &&
    reading.day &&
    reading.time
  ) {
    return {
      decision: 'picked',
      activity: reading.activity,
      kid: reading.kid,
      day: reading.day,
      time: reading.time,
    };
  }
  if (reading.decision === 'passed' && reading.activity && reading.kid) {
    return { decision: 'passed', activity: reading.activity, kid: reading.kid };
  }
  return null;
}

/**
 * Every skip is named in the result. Only the ones that follow a decision the model did
 * read are logged: the sweep being off, a family with no group and an ordinary text are
 * most 1:1 turns, and the screen logs its own unread.
 */
function skipped(reason: ActivityDecisionSkip): ActivityDecisionOutcome {
  if (reason === 'unknown_kid' || reason === 'not_queued') {
    console.info({ reason }, 'activity decision: read, nothing queued');
  }
  return { status: 'skipped', reason };
}

/**
 * Queue a 1:1 decision for the household group. The kid must be a child on
 * this family (given name, case-insensitive). Anything else is skipped, by name.
 */
export async function queueActivityDecisionFromReply(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    originChatId: string | null;
    body: string;
    now: Date;
    /** The meaning screen. Absent: the shared production screen. */
    screen?: MeaningScreen;
  },
): Promise<ActivityDecisionOutcome> {
  if (!modelReadSweepEnabled()) return skipped('sweep_off');
  if (typeof database.select !== 'function') return skipped('no_group');
  if (
    !(await groupDecisionSyncOpen(database, {
      familyId: input.familyId,
      originChatId: input.originChatId,
    }))
  ) {
    return skipped('no_group');
  }
  const kids = await database
    .select({ name: schema.children.name, familyId: schema.children.familyId })
    .from(schema.children)
    .where(eq(schema.children.familyId, input.familyId));
  if (kids.length === 0) return skipped('no_children');
  const decision = await readActivityDecision(input.screen ?? sharedMeaningScreen(), input.body);
  if (decision === 'unread') return skipped('unread');
  if (!decision) return skipped('not_a_decision');
  const named = kids.find(
    (row) =>
      row.familyId === input.familyId &&
      row.name.trim().toLowerCase() === decision.kid.trim().toLowerCase(),
  );
  if (!named) return skipped('unknown_kid');
  const queued = await queueGroupActivityDecision(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    originChatId: input.originChatId,
    decision: { ...decision, kid: named.name.trim() },
    now: input.now,
  });
  return queued === 'queued' ? { status: 'queued' } : skipped('not_queued');
}
