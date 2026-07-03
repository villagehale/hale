/**
 * The time layer. HARD rule: a timestamp is NEVER formatted against the server's
 * ambient timezone (Vercel runs UTC) or a per-viewer browser guess on the server
 * render — a 3:12pm feed must not read 7:12pm because the box is in UTC. Every
 * surface that renders a stored instant runs it through here with an EXPLICIT
 * IANA timezone (the family's, loaded server-side), so the same instant reads the
 * same way for every viewer and matches the digest email.
 *
 * Two shapes, deliberately distinct:
 *  - INSTANTS (audit occurredAt, drafted-at, a log's occurredAt): a true point in
 *    time. Formatted in the family's zone — `formatTime` / `formatDateTime` /
 *    `formatWhenPhrase` / `formatLongDate`.
 *  - CALENDAR DATES (a plan's scheduledFor, entered via `<input type="date">` and
 *    stored as UTC-midnight): a bare day, NOT an instant. Formatted with
 *    `formatCalendarDate` in UTC, which round-trips the exact day the parent
 *    typed regardless of any viewer's zone — never shifting it a day.
 *
 * Old dates carry the year (`Jun 11, 2025`) so a stale row can't masquerade as
 * this year; a same-year date omits it (`Jun 11`). "This year" is judged in the
 * same zone the value is rendered in, so a Dec-31-evening row near the UTC year
 * boundary is judged by its local year, not UTC's.
 */

/**
 * Web-render fallback zone when a family has no resolvable timezone. Mirrors the
 * `users.timezone` column default (packages/db schema) — the app never renders a
 * timestamp against the server's ambient zone.
 */
export const DEFAULT_TIMEZONE = 'America/Toronto';

const LOCALE = 'en-CA';

function yearIn(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { year: 'numeric', timeZone }).format(date);
}

/** True when `date`, rendered in `timeZone`, falls in a different calendar year
 * than `now` — the signal to include the year in the display. */
function isOtherYear(date: Date, timeZone: string, now: Date): boolean {
  return yearIn(date, timeZone) !== yearIn(now, timeZone);
}

/**
 * A stable `YYYY-MM-DD` key for the calendar day `iso` falls on IN `timeZone` —
 * so the trail groups rows by the family's local day, and a 1am-ET row near the
 * UTC boundary groups under its local day, not UTC's. `en-CA` renders ISO order.
 */
export function dayKeyOf(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone,
  }).format(new Date(iso));
}

/**
 * `Thursday, Jun 11` — the human heading for a trail day-group, in the family's
 * zone, with the year on other-year days. Also the trail CSV's date column, so an
 * exported row carries its full day, not just the time.
 */
export function formatDayHeading(
  iso: string | Date,
  timeZone: string,
  now: Date = new Date(),
): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: isOtherYear(date, timeZone, now) ? 'numeric' : undefined,
    timeZone,
  }).format(date);
}

/** `HH:MM`, 24-hour, in the family's zone. Trail row time-stamp. */
export function formatTime(iso: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(new Date(iso));
}

/** `Mon 5, 15:12` (24-hour), in the family's zone, with the year on other-year
 * dates. Approvals drafted-at. */
export function formatDateTime(
  iso: string | Date,
  timeZone: string,
  now: Date = new Date(),
): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat(LOCALE, {
    month: 'short',
    day: 'numeric',
    year: isOtherYear(date, timeZone, now) ? 'numeric' : undefined,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  }).format(date);
}

/** `Mon 5, 3:12 p.m.` (12-hour), in the family's zone, with the year on
 * other-year dates. Recent-logs "when" phrase. */
export function formatWhenPhrase(
  iso: string | Date,
  timeZone: string,
  now: Date = new Date(),
): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat(LOCALE, {
    month: 'short',
    day: 'numeric',
    year: isOtherYear(date, timeZone, now) ? 'numeric' : undefined,
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(date);
}

/**
 * `Mon 5` for a bare CALENDAR date stored as UTC-midnight (a `<input type="date">`
 * value), with the year on other-year dates. Formatted in UTC so the day the
 * parent typed round-trips exactly — never shifted by the viewer's offset.
 */
export function formatCalendarDate(iso: string | Date, now: Date = new Date()): string {
  const date = new Date(iso);
  return new Intl.DateTimeFormat(LOCALE, {
    month: 'short',
    day: 'numeric',
    year: isOtherYear(date, 'UTC', now) ? 'numeric' : undefined,
    timeZone: 'UTC',
  }).format(date);
}

/** The parts of the page-corner long-date stamp, computed in the family's zone so
 * a parent at 11pm ET never sees the server's (UTC) "tomorrow". Lower-cased to the
 * surface's typographic style by the caller. */
export interface LongDateParts {
  weekday: string;
  month: string;
  day: string;
  year: string;
}

export function formatLongDate(date: Date, timeZone: string): LongDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  return {
    weekday: pick('weekday').toLowerCase(),
    month: pick('month').toLowerCase(),
    day: pick('day'),
    year: pick('year'),
  };
}
