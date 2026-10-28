import { addDaysToKey, dayKeyIn, zonedLocalInstant } from '~/lib/plan/spine';

/**
 * VIL-393 — when a household may be asked, once, how a new activity is going.
 *
 * One ask, the evening after the FIRST session ends. Not every text, and a missed
 * evening is not caught up later (fewer asks wins every tie). A parent who turned
 * check-ins off is never asked.
 */

/** How often this household wants Hale to ask. `fewer` is the unset default. */
export type AskPreference = 'off' | 'fewer' | 'regular';

export type CheckInCadence = 'daily' | 'weekly' | 'off';

export type MidActivitySkipReason = 'already_asked' | 'preference_off' | 'too_soon' | 'past_window';

export type MidActivityDecision =
  | { ask: true; opensAt: Date; closesAt: Date }
  | { ask: false; reason: MidActivitySkipReason };

/** The local evening the ask belongs to. Inside the quiet-hours day on purpose. */
export const ASK_EVENING_OPENS = '18:00';
/** A session that ends after this asks the NEXT evening, not at bedtime. */
export const ASK_EVENING_LAST_START = '21:00';
/** The ask lapses the next local morning: a stale "how was it" is noise. */
export const ASK_LAPSES_AT = '08:00';

/** A session with no stored end is taken to last this long. */
export const DEFAULT_SESSION_MS = 60 * 60 * 1000;

/**
 * No stored check-in row means the parent has not asked to hear from Hale more
 * often. That is `fewer`, on purpose: the evening check-in treats a missing row
 * as daily, and copying that default would ask more households, not fewer.
 */
export function preferenceFromCheckIn(row: { cadence: CheckInCadence } | null): AskPreference {
  if (row === null) return 'fewer';
  if (row.cadence === 'off') return 'off';
  if (row.cadence === 'weekly') return 'fewer';
  return 'regular';
}

/** The first session's end, from its own end or its start plus a default length. */
export function firstSessionEnd(
  sessions: readonly { startsAt: Date; endsAt: Date | null }[],
): Date | null {
  let first: { startsAt: Date; endsAt: Date | null } | null = null;
  for (const session of sessions) {
    if (Number.isNaN(session.startsAt.getTime())) continue;
    if (first === null || session.startsAt.getTime() < first.startsAt.getTime()) first = session;
  }
  if (first === null) return null;
  const end = first.endsAt;
  if (end && !Number.isNaN(end.getTime()) && end.getTime() > first.startsAt.getTime()) return end;
  return new Date(first.startsAt.getTime() + DEFAULT_SESSION_MS);
}

/**
 * The evening after the first session: opens at 18:00 local on the day it ended (or
 * when it ended, if later), and moves to the next evening when it ended after 21:00.
 * Closes at 08:00 the following local morning.
 */
export function firstSessionAskWindow(
  endedAt: Date,
  timeZone: string,
): { opensAt: Date; closesAt: Date } {
  let day = dayKeyIn(endedAt, timeZone);
  let opensAt = zonedLocalInstant(day, ASK_EVENING_OPENS, timeZone);
  if (endedAt.getTime() >= zonedLocalInstant(day, ASK_EVENING_LAST_START, timeZone).getTime()) {
    day = addDaysToKey(day, 1);
    opensAt = zonedLocalInstant(day, ASK_EVENING_OPENS, timeZone);
  } else if (endedAt.getTime() > opensAt.getTime()) {
    opensAt = endedAt;
  }
  const closesAt = zonedLocalInstant(addDaysToKey(day, 1), ASK_LAPSES_AT, timeZone);
  return { opensAt, closesAt };
}

/** Ask once, inside the window. Before it is `too_soon`; after it is `past_window`. */
export function decideMidActivityAsk(input: {
  preference: AskPreference;
  firstSessionEndedAt: Date;
  timeZone: string;
  now: Date;
  alreadyAsked: boolean;
}): MidActivityDecision {
  if (input.alreadyAsked) return { ask: false, reason: 'already_asked' };
  if (input.preference === 'off') return { ask: false, reason: 'preference_off' };
  const { opensAt, closesAt } = firstSessionAskWindow(input.firstSessionEndedAt, input.timeZone);
  if (input.now.getTime() < opensAt.getTime()) return { ask: false, reason: 'too_soon' };
  if (input.now.getTime() >= closesAt.getTime()) return { ask: false, reason: 'past_window' };
  return { ask: true, opensAt, closesAt };
}
