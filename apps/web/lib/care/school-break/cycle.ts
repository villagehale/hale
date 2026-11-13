import { addDaysToKey } from '~/lib/plan/spine';

/**
 * VIL-685 · which winter break a date belongs to.
 *
 * A school year runs September to August, so the 2026-27 year's winter break is the one
 * that starts in December 2026. Everything here is calendar arithmetic on family-local
 * day keys (`YYYY-MM-DD`); nothing here is a date any school published.
 */

/** `2026-27` for any day from 2026-09-01 to 2027-08-31. */
export function schoolYearOf(today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const start = month >= 9 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

function startYear(schoolYear: string): number {
  return Number(schoolYear.slice(0, 4));
}

/**
 * The days a WINTER break of this school year can start or end on: December of the
 * first year through January of the second. A reading outside it is another break (a
 * March break, last year's table) and is refused rather than stored. A sanity bound on
 * what the page or the parent said, never a date Hale states.
 */
export function winterBreakBounds(schoolYear: string): { earliest: string; latest: string } {
  const year = startYear(schoolYear);
  return { earliest: `${year}-12-01`, latest: `${year + 1}-01-31` };
}

/**
 * The last day asking a parent when their winter break is still buys anything: Dec 15,
 * the candidate's `worthlessAfter`. A break that starts in the second half of December
 * is days away by then, and a question that late arrives too late to plan around. The
 * decider still picks the moment before it.
 */
export function lastAskDay(schoolYear: string): string {
  return addDaysToKey(winterBreakBounds(schoolYear).earliest, 14);
}

/** Both days inside this school year's winter bounds, in order. */
export function isWinterBreak(schoolYear: string, firstDay: string, lastDay: string): boolean {
  const { earliest, latest } = winterBreakBounds(schoolYear);
  return firstDay >= earliest && lastDay <= latest && firstDay <= lastDay;
}

/** The event key a winter break is asked about under: colon-free, ending in its first
 * day, the shape `nudge-decide` requires of every verified break. */
export function winterBreakEventKey(firstDay: string): string {
  return `winter-break-${firstDay}`;
}
