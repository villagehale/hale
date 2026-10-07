import { formatLocalDate, localDateParts, timezoneOffsetMs } from './period';

export type WorkstreamLanguage = 'en' | 'fr';

/** `fr` and `fr-CA` are French. Everything else is English. */
export function workstreamLanguage(primary: string | null | undefined): WorkstreamLanguage {
  return primary?.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

/** `2026-10-08T11:00:00-04:00` — the instant in `timeZone`, offset included. */
export function formatOffsetIso(instant: Date, timeZone: string): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
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
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const offsetMs = timezoneOffsetMs(instant, timeZone);
  const sign = offsetMs >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMs);
  const hours = String(Math.floor(abs / 3_600_000)).padStart(2, '0');
  const minutes = String(Math.floor((abs % 3_600_000) / 60_000)).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}${sign}${hours}:${minutes}`;
}

export function localWeekday(
  instant: Date,
  timeZone: string,
  language: WorkstreamLanguage,
): string {
  return new Intl.DateTimeFormat(language === 'fr' ? 'fr-CA' : 'en-CA', {
    weekday: 'long',
    timeZone,
  }).format(instant);
}

export function localDate(instant: Date, timeZone: string): string {
  return formatLocalDate(localDateParts(instant, timeZone));
}

/** Monday = 0 … Sunday = 6, in `timeZone`. */
export function isoWeekdayIndex(instant: Date, timeZone: string): number {
  return (localDateParts(instant, timeZone).weekday + 6) % 7;
}

function zonedWallTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): Date {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offset = timezoneOffsetMs(guess, timeZone);
  const instant = new Date(guess.getTime() - offset);
  const offsetAtInstant = timezoneOffsetMs(instant, timeZone);
  if (offsetAtInstant !== offset) return new Date(guess.getTime() - offsetAtInstant);
  return instant;
}

const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A model time, as an instant.
 *
 * A value with `Z` or a numeric offset is that instant. A naive clock time is
 * wall time in `timeZone` (the server is UTC, and must not be the reader).
 * A bare date is 09:00 in that zone. Unreadable input is null.
 */
export function interpretCheckBack(value: string, timeZone: string): Date | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (HAS_ZONE.test(trimmed)) {
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const clock = NAIVE_DATE_TIME.exec(trimmed);
  if (clock) {
    return zonedWallTime(
      Number(clock[1]),
      Number(clock[2]),
      Number(clock[3]),
      Number(clock[4]),
      Number(clock[5]),
      Number(clock[6] ?? 0),
      timeZone,
    );
  }
  const day = DATE_ONLY.exec(trimmed);
  if (day) {
    return zonedWallTime(Number(day[1]), Number(day[2]), Number(day[3]), 9, 0, 0, timeZone);
  }
  return null;
}

/**
 * The instant to store, or null when it is missing, unreadable, or not still
 * in the future. Undefined stays undefined so an update can leave the column.
 */
export function resolveCheckBackAt(
  value: string | null | undefined,
  now: Date,
  timeZone: string,
): Date | null | undefined {
  if (value === undefined) return undefined;
  const instant = interpretCheckBack(value ?? '', timeZone);
  if (!instant || instant.getTime() <= now.getTime()) return null;
  return instant;
}
