/**
 * Registration seasons in a family's timezone, aligned to when city rec
 * typically opens — not calendar quarters, which split winter registration
 * (October–January) across Q4 and Q1.
 *
 * Windows (local calendar dates):
 *   - winter: Oct 1 – Jan 31  (matches `winterRegistrationWindow` in web)
 *   - spring: Feb 1 – Mar 31
 *   - summer: Apr 1 – Jun 30
 *   - fall:   Jul 1 – Sep 30
 *
 * Winter is keyed by the January year of the programs: 15 Oct 2026 and
 * 15 Jan 2027 are both `2027-winter`. `resetsOn` is the next season's first
 * local calendar day (YYYY-MM-DD).
 */

export const REGISTRATION_SEASONS = ['winter', 'spring', 'summer', 'fall'] as const;
export type RegistrationSeason = (typeof REGISTRATION_SEASONS)[number];

export interface RegistrationSeasonWindow {
  /** `YYYY-winter` / `YYYY-spring` / `YYYY-summer` / `YYYY-fall`. */
  key: string;
  season: RegistrationSeason;
  /** Next season's first local calendar day, YYYY-MM-DD in `timeZone`. */
  resetsOn: string;
}

function localYmd(
  now: Date,
  timeZone: string,
): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now);
  const num = (type: Intl.DateTimeFormatPartTypes) => {
    const value = parts.find((part) => part.type === type)?.value;
    return value ? Number(value) : Number.NaN;
  };
  return { year: num('year'), month: num('month'), day: num('day') };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * The registration season containing `now` in `timeZone`. An invalid IANA
 * zone falls back to UTC rather than throwing (the column default is UTC).
 */
export function registrationSeasonOf(now: Date, timeZone: string): RegistrationSeasonWindow {
  let year: number;
  let month: number;
  try {
    const local = localYmd(now, timeZone);
    if (!Number.isFinite(local.year) || !Number.isFinite(local.month)) {
      throw new RangeError('invalid timezone parts');
    }
    year = local.year;
    month = local.month;
  } catch {
    const utc = localYmd(now, 'UTC');
    year = utc.year;
    month = utc.month;
  }

  if (month >= 10) {
    return { key: `${year + 1}-winter`, season: 'winter', resetsOn: ymd(year + 1, 2, 1) };
  }
  if (month === 1) {
    return { key: `${year}-winter`, season: 'winter', resetsOn: ymd(year, 2, 1) };
  }
  if (month <= 3) {
    return { key: `${year}-spring`, season: 'spring', resetsOn: ymd(year, 4, 1) };
  }
  if (month <= 6) {
    return { key: `${year}-summer`, season: 'summer', resetsOn: ymd(year, 7, 1) };
  }
  return { key: `${year}-fall`, season: 'fall', resetsOn: ymd(year, 10, 1) };
}
