import type { SeasonRegistrationWindow } from '../verify-window';

/**
 * VIL-684 · the season the own-city lookup asks about: the coming winter. Winter
 * programs start in January and register in the weeks before, so from February on the
 * winter worth knowing about is next year's.
 */
function winterSeasonYear(now: Date): number {
  const year = now.getUTCFullYear();
  return now.getUTCMonth() >= 1 ? year + 1 : year;
}

export function winterCycleLabel(now: Date): string {
  return `Winter ${winterSeasonYear(now)}`;
}

/** The first day, in the year before, a winter season's registration can open on. */
const WINTER_REGISTRATION_FROM = '10-01';
/** The last day it can open on: the end of January, the month its programs start. */
const WINTER_REGISTRATION_THROUGH = '01-31';

/** The days the coming winter's registration opens in: what a year pinned by a printed
 * weekday must fall in (`pinYearByWeekday`), so next winter's date, or a spring or summer
 * one, is never read as this winter's. */
export function winterRegistrationWindow(now: Date): SeasonRegistrationWindow {
  const year = winterSeasonYear(now);
  return {
    from: `${year - 1}-${WINTER_REGISTRATION_FROM}`,
    through: `${year}-${WINTER_REGISTRATION_THROUGH}`,
  };
}
