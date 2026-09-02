/**
 * The one global window dial (7/30/90/365) and the day-bucket vocabulary every
 * admin trend shares. Pure — imported by Server Components (queries) AND the
 * client dial/charts, so nothing here may touch env, db, or React.
 *
 * Trend queries return TREND_DAYS daily buckets ONCE; the client slices a
 * window locally, so flipping the dial costs zero round trips.
 */

export const ADMIN_TIME_ZONE = 'America/Toronto';
export const TREND_DAYS = 365;

export const WINDOW_OPTIONS = [7, 30, 90, 365] as const;
export type WindowDays = (typeof WINDOW_OPTIONS)[number];

/** 'YYYY-MM-DD' for an instant, in the admin timezone (en-CA is ISO-shaped). */
export function dayKey(at: Date, timeZone: string = ADMIN_TIME_ZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

/** The last `days` day-keys ending at `today`, oldest first. UTC-noon stepping
 * so a DST boundary can never skip or double a day. */
export function lastDays(days: number, today: string = dayKey(new Date())): string[] {
  const [y, m, d] = today.split('-').map(Number);
  const base = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12);
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(new Date(base - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

/** Continuous window over sparse day rows: one row per day, `zero` where the
 * query returned nothing. This is the client-side dial slice. */
export function fillWindow<T extends { day: string }>(
  rows: readonly T[],
  days: number,
  zero: Omit<T, 'day'>,
  today?: string,
): T[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  return lastDays(days, today).map((day) => byDay.get(day) ?? ({ day, ...zero } as T));
}

/**
 * `?w=` → a valid dial stop. Anything that isn't exactly one of WINDOW_OPTIONS
 * (absent, garbage, an in-between number) falls back to the 30d default — a
 * deep link can never put the dial in a state the buttons can't reach.
 */
export function parseWindowParam(value: string | null): WindowDays {
  const parsed = Number(value);
  return WINDOW_OPTIONS.find((option) => option === parsed) ?? 30;
}

export const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/** Weekday index (0 = Monday … 6 = Sunday) of a 'YYYY-MM-DD' day key. UTC-noon
 * construction, the lastDays trick, so a DST boundary can never shift the day. */
export function weekdayOfDayKey(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  const utcDay = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12)).getUTCDay();
  return (utcDay + 6) % 7;
}
