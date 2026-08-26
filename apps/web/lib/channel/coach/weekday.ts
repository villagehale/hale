import { zonedLocalInstant } from '~/lib/plan/spine';

/**
 * VIL-295 — the model states which weekday it thinks its date is, and the date is
 * checked against it before anything is drafted.
 *
 * THE INCIDENT. A parent asked, out loud, for swim lessons "this Thursday at four
 * thirty" on Thursday 2026-08-20. The turn drafted, and said: "Swim lessons this
 * Thursday, August twenty-second at four thirty, pending your yes." August 22nd was a
 * Saturday. The sentence contradicted itself, the parent had no screen to re-read, and
 * the row was minted either way.
 *
 * WHY A CHECK AND NOT A BETTER PROMPT. Resolving "this Thursday" to a calendar date is
 * arithmetic, and `zonedLocalInstant` validates only that the string is shaped like a
 * date — so the model's answer was the only answer, and nothing in the system could
 * disagree with it. Asking the model to state the weekday as WELL as the date is what
 * turns an unverifiable inference into a verifiable claim: two facts that must agree, one
 * of which a computer can check for free.
 *
 * WHY THE REFUSAL NAMES BOTH TRUE DATES. A refusal the model cannot act on costs a step
 * and buys nothing. Given "the 22nd is a Saturday" and "the Thursday of that week is the
 * 20th", one re-ask fixes it — the #530/#532 re-ask shape, where the correction carries
 * the fact the caller was missing.
 *
 * THERE IS NO SECOND CHANCE BRANCH, deliberately. A mismatched draft is never acceptable,
 * so there is no attempt-counter after which one is let through; the tool refuses every
 * time and the turn either fixes it or answers without drafting.
 */

/** The weekday tokens, in `Date.getUTCDay()` order so the index IS the day number. */
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export type Weekday = (typeof WEEKDAYS)[number];

/** The full names, for a refusal a model reads as English rather than as an enum. */
const FULL_NAME: Record<Weekday, string> = {
  sun: 'Sunday',
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
};

/** Which weekday a family-local wall-clock date actually falls on. */
export function weekdayOf(dayKey: string, timeZone: string): Weekday {
  // Noon, so the answer cannot be moved by a DST shift at either end of the day.
  const at = zonedLocalInstant(dayKey, '12:00', timeZone);
  const short = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone })
    .format(at)
    .toLowerCase();
  const found = WEEKDAYS.find((day) => day === short);
  if (!found) throw new Error(`weekdayOf: unreadable weekday '${short}' for ${dayKey}`);
  return found;
}

/** The date of `weekday` in the same Sunday-start week as `dayKey` — the other half of
 * the correction, so the model is handed the date it meant rather than told to guess
 * again. */
function sameWeekDate(dayKey: string, weekday: Weekday, timeZone: string): string {
  const actual = WEEKDAYS.indexOf(weekdayOf(dayKey, timeZone));
  const wanted = WEEKDAYS.indexOf(weekday);
  const parts = dayKey.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + (wanted - actual)));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Null when the model's `date` and its `weekday` agree. Otherwise the violation, written
 * as the sentence the model is handed back — both true dates, and what to do with them.
 */
export function weekdayViolation(input: {
  date: string;
  weekday: Weekday;
  timeZone: string;
  tool: string;
}): string | null {
  const actual = weekdayOf(input.date, input.timeZone);
  if (actual === input.weekday) return null;
  return `${input.date} is a ${FULL_NAME[actual]}, not a ${FULL_NAME[input.weekday]}. The ${FULL_NAME[input.weekday]} of that week is ${sameWeekDate(input.date, input.weekday, input.timeZone)}. Work out which one the parent meant and call ${input.tool} again with a date and a weekday that agree — and say the same day back to them.`;
}
