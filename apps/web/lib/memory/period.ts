/**
 * Local calendar periods for memory digests. The identity of a day or week is a
 * date in the parent's timezone, not a UTC instant, so a 23:00 text and a 01:00
 * text do not swap days when the cron runs in UTC.
 */

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  /** 0 = Sunday, matching `Date#getUTCDay`. */
  weekday: number;
}

export function formatLocalDate(parts: { year: number; month: number; day: number }): string {
  const month = String(parts.month).padStart(2, '0');
  const day = String(parts.day).padStart(2, '0');
  return `${parts.year}-${month}-${day}`;
}

export function localDateParts(instant: Date, timeZone: string): LocalDateParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  const weekday = WEEKDAY_INDEX[parts.weekday ?? ''];
  if (weekday === undefined || !parts.year || !parts.month || !parts.day) {
    throw new Error('memory period: could not read a local date');
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday,
  };
}

export function addCalendarDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return formatLocalDate({
    year: utc.getUTCFullYear(),
    month: utc.getUTCMonth() + 1,
    day: utc.getUTCDate(),
  });
}

/** Monday of the week containing `date`. */
export function weekStartMonday(date: string): string {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const delta = weekday === 0 ? -6 : 1 - weekday;
  return addCalendarDays(date, delta);
}

function timezoneOffsetMs(instant: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(instant).map((part) => [part.type, part.value]),
  );
  let hour = Number(parts.hour);
  // A few engines emit 24 for midnight.
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - instant.getTime();
}

/** UTC instant of local midnight at the start of `date` in `timeZone`. */
export function zonedMidnight(date: string, timeZone: string): Date {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number];
  const guess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));
  const offset = timezoneOffsetMs(guess, timeZone);
  const instant = new Date(guess.getTime() - offset);
  const offsetAtInstant = timezoneOffsetMs(instant, timeZone);
  if (offsetAtInstant !== offset) return new Date(guess.getTime() - offsetAtInstant);
  return instant;
}

export function previousLocalDay(now: Date, timeZone: string): string {
  return addCalendarDays(formatLocalDate(localDateParts(now, timeZone)), -1);
}

export interface PeriodWindow {
  periodStart: string;
  start: Date;
  end: Date;
}

/** The completed local day before `now`, and the Monday-week that contains it. */
export function digestWindows(
  now: Date,
  timeZone: string,
): { day: PeriodWindow; week: PeriodWindow } {
  const dayStart = previousLocalDay(now, timeZone);
  const dayEnd = addCalendarDays(dayStart, 1);
  const weekStart = weekStartMonday(dayStart);
  return {
    day: {
      periodStart: dayStart,
      start: zonedMidnight(dayStart, timeZone),
      end: zonedMidnight(dayEnd, timeZone),
    },
    week: {
      periodStart: weekStart,
      start: zonedMidnight(weekStart, timeZone),
      end: zonedMidnight(dayEnd, timeZone),
    },
  };
}
