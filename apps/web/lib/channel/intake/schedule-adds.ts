import { type Database, schema } from '@hale/db';
import { AHA_TIME_ZONE } from '~/lib/channel/connect/aha-read';
import { createFamilyEvent } from '~/lib/loop/queries';
import { zonedMidnight } from '~/lib/memory/period';
import { addDaysToKey, zonedLocalInstant } from '~/lib/plan/spine';
import {
  DEFAULT_SCHEDULE_WEEKS,
  MAX_SCHEDULE_WEEKS,
  type ScheduleAdd,
  activityFromFindLine,
} from './onboarding-turn';
import type { FirstTouchScheduled } from './session';

/**
 * Step 9 of onboarding: the activities the parent agreed to put on the
 * calendar. The model settled the day in conversation and returned shape-
 * checked adds; this writes them as family events through the same path the
 * plan uses, so the ICS feed and reminders pick them up. A reminder, not a
 * registration: nothing here contacts a venue. Every add is audited (rule #6).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

function startOf(add: ScheduleAdd, dayKey: string): { startsAt: Date; endsAt: Date | null } {
  if (add.time)
    return { startsAt: zonedLocalInstant(dayKey, add.time, AHA_TIME_ZONE), endsAt: null };
  const midnight = zonedMidnight(dayKey, AHA_TIME_ZONE);
  return { startsAt: midnight, endsAt: new Date(midnight.getTime() + DAY_MS) };
}

export interface ScheduleWriteResult {
  scheduled: FirstTouchScheduled[];
  eventIds: string[];
}

/**
 * Write each accepted add. A weekly add writes one event per week from the
 * first date, up to {@link MAX_SCHEDULE_WEEKS}. A line already scheduled is
 * not written twice.
 */
export async function writeScheduleAdds(
  database: Database,
  input: {
    familyId: string;
    userId: string;
    sessionId: string;
    adds: readonly ScheduleAdd[];
    lines: readonly string[];
    already: readonly FirstTouchScheduled[];
  },
): Promise<ScheduleWriteResult> {
  const scheduled: FirstTouchScheduled[] = [];
  const eventIds: string[] = [];
  for (const add of input.adds) {
    const line = input.lines[add.line - 1];
    if (!line) continue;
    // One reminder series per line: a line already on the calendar is not written again.
    if (input.already.some((row) => row.line === add.line)) continue;
    if (scheduled.some((row) => row.line === add.line)) continue;
    const { activity } = activityFromFindLine(line);
    const weeks =
      add.cadence === 'weekly'
        ? Math.min(add.weeks ?? DEFAULT_SCHEDULE_WEEKS, MAX_SCHEDULE_WEEKS)
        : 1;
    for (let week = 0; week < weeks; week += 1) {
      const dayKey = addDaysToKey(add.date, week * 7);
      const { startsAt, endsAt } = startOf(add, dayKey);
      const id = await createFamilyEvent(database, {
        familyId: input.familyId,
        childId: null,
        title: activity,
        startsAt,
        endsAt,
        location: null,
        source: 'channel',
        createdBy: input.userId,
      });
      eventIds.push(id);
    }
    const row: FirstTouchScheduled = {
      line: add.line,
      title: activity,
      cadence: add.cadence,
      date: add.date,
      time: add.time,
    };
    scheduled.push(row);
    await database.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.userId,
      actionTaken: 'onboarding_schedule_added',
      targetTable: 'family_events',
      targetId: input.sessionId,
      after: { ...row, weeks, kind: 'reminder' },
    });
  }
  return { scheduled, eventIds };
}
