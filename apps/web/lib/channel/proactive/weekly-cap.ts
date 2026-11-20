import { type Database, schema } from '@hale/db';
import { and, asc, eq, gt, inArray, lte } from 'drizzle-orm';
import type { ProactiveSendKind } from '~/lib/channel/outbound-gate';

/**
 * VIL-722 · one weekly budget per family on what Hale sends first. Built default off, with
 * no number: Barton decided on 2026-11-19 that there is no cap for now, and the number
 * comes later from how real families react.
 *
 * Two switches, both needed. `PROACTIVE_WEEKLY_CAP_ENABLED` (flag.ts) is the flag, and
 * {@link PROACTIVE_WEEKLY_CAP_SENDS_ENV} is the number. A flag that is on with no number
 * caps nothing, and the hourly review logs that and counts it in its summary.
 *
 * It sits beside the daily decision cap, in the hourly review, rather than in the outbound
 * gate. The gate decides consent, opt-out and quiet hours for every class, and it holds no
 * count. Volume is the decider's call, and this budget is a rail on that call: it holds a
 * text the decider chose to send. Once `PROACTIVE_CADENCE` is `live`, every class it counts
 * reaches a phone only through the decider. Under `shadow` the sweeps still send their own
 * classes, outside this budget, and under `off` the review sends nothing at all.
 *
 * Exempt by construction, because none of them is a decider send: replies to the parent,
 * the night-before and 1-hour-before reminders (lib/loop/reminders), and the group
 * reminders a parent asked for (lib/loop/reminders/group). Exempt by
 * {@link WEEKLY_CAP_CLASS}: the classes a parent asked for or is owed. Exempt per item: a
 * candidate with `parentRequested`.
 *
 * Nothing is ever said to a parent about the budget. A held text waits, by name, and the
 * decider is asked again once the budget frees.
 */

/** The number of sends one family may receive in any seven days. Config, not a flag. */
export const PROACTIVE_WEEKLY_CAP_SENDS_ENV = 'PROACTIVE_WEEKLY_CAP_SENDS';

/** A rolling seven days, so a busy Sunday and a busy Monday are one week, not two. */
export const WEEKLY_CAP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether each proactive class spends the weekly budget. Every class is listed, so a new
 * one cannot be added without choosing.
 *
 * `exempt` is for a text the parent asked for or is owed. The immediate classes
 * (flag.ts PROACTIVE_ROUTING) never reach the decider, so their row records intent; it
 * changes nothing today.
 */
export const WEEKLY_CAP_CLASS: Record<ProactiveSendKind, 'counted' | 'exempt'> = {
  nudge: 'counted',
  // The parent approved this ladder for one registration window: reminders they asked for.
  registration_sequence: 'exempt',
  village_intro: 'counted',
  followup: 'counted',
  plan_check_in: 'counted',
  // The finds Hale said it would come back with, after the parent asked: an owed reply.
  activity_followup: 'exempt',
  // A watch the parent armed. They asked to be told when the seat opens.
  spot_open: 'exempt',
  spot_open_instant: 'exempt',
  email_alert: 'counted',
  calendar_alert: 'counted',
  evening_check_in: 'counted',
  mid_activity_ask: 'counted',
  next_day_checkback: 'counted',
  registration_opening: 'counted',
  school_break_ask: 'counted',
  co_parent_departed: 'counted',
  travel_brief: 'counted',
  duty_ask: 'counted',
  // The text that makes acting on a kind the parent granted allowed (rule #4), and the
  // receipt for what Hale then did. A count could only drop the consent's own text.
  autonomy_armed: 'exempt',
  autonomy_acted: 'exempt',
};

/** The classes that spend the budget, in table order. */
export const WEEKLY_CAP_COUNTED_KINDS: readonly ProactiveSendKind[] = (
  Object.keys(WEEKLY_CAP_CLASS) as ProactiveSendKind[]
).filter((kind) => WEEKLY_CAP_CLASS[kind] === 'counted');

export type WeeklyCapSetting = { limit: number } | { limit: null; reason: 'unset' | 'invalid' };

/**
 * The number, read the way the other config numbers are (`parseUsd` in
 * packages/agent/src/credit-alert.ts): a positive whole number. Unset is `unset`. Anything
 * else, zero included, is `invalid`, and neither one caps anything.
 */
export function weeklyCapSetting(
  env: Record<string, string | undefined> = process.env,
): WeeklyCapSetting {
  const raw = env[PROACTIVE_WEEKLY_CAP_SENDS_ENV];
  if (raw === undefined) return { limit: null, reason: 'unset' };
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return { limit: null, reason: 'invalid' };
  return { limit: parsed };
}

/** Whether one chosen item spends the budget: its class counts, and the parent did not ask. */
export function countsTowardWeeklyCap(item: {
  kind: ProactiveSendKind;
  parentRequested: boolean;
}): boolean {
  return WEEKLY_CAP_CLASS[item.kind] === 'counted' && !item.parentRequested;
}

/**
 * The moments in the last seven days at which the decider sent this family something that
 * counts, oldest first. One send is one moment: every row a review sends is marked with
 * that review's `now` (review.ts `mark`), so a text that carried three items, and the
 * copies two parents each got of it, are one send to the household. A row that was held,
 * dropped or shadowed never left, so it spent nothing.
 */
export async function weeklyCapSends(
  database: Database,
  familyId: string,
  now: Date,
): Promise<Date[]> {
  const since = new Date(now.getTime() - WEEKLY_CAP_WINDOW_MS);
  const rows = await database
    .selectDistinct({ at: schema.proactiveCandidates.decidedAt })
    .from(schema.proactiveCandidates)
    .where(
      and(
        eq(schema.proactiveCandidates.familyId, familyId),
        eq(schema.proactiveCandidates.status, 'sent'),
        eq(schema.proactiveCandidates.parentRequested, false),
        inArray(schema.proactiveCandidates.kind, [...WEEKLY_CAP_COUNTED_KINDS]),
        gt(schema.proactiveCandidates.decidedAt, since),
        lte(schema.proactiveCandidates.decidedAt, now),
      ),
    )
    .orderBy(asc(schema.proactiveCandidates.decidedAt));
  return rows.map((row) => row.at).filter((at): at is Date => at !== null);
}

export type WeeklyCapVerdict =
  | { over: false; spent: number }
  | { over: true; spent: number; reopensAt: Date };

/**
 * Over once the window holds `limit` sends. It reopens when enough of them have aged out
 * of the window to leave room for one more, which is the moment the oldest send that
 * still keeps it full turns seven days old.
 */
export function weeklyCapVerdict(sends: readonly Date[], limit: number): WeeklyCapVerdict {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new RangeError('weeklyCapVerdict: the limit is a positive whole number');
  }
  if (sends.length < limit) return { over: false, spent: sends.length };
  const ordered = [...sends].sort((a, b) => a.getTime() - b.getTime());
  const freeing = ordered[ordered.length - limit] as Date;
  return {
    over: true,
    spent: sends.length,
    reopensAt: new Date(freeing.getTime() + WEEKLY_CAP_WINDOW_MS),
  };
}
