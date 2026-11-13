/**
 * VIL-531 — a child's date of birth is a calendar day, not an instant.
 *
 * `new Date('2016-05-01')` is UTC midnight; local getters in America/Toronto
 * read April 30, and `new Date('2016-05-01T00:00:00').toISOString()` on a UTC
 * server can shift the civil day the other way. Intake stores the YYYY-MM-DD
 * the parent named, with no timezone conversion.
 */

const CIVIL_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;

/**
 * The calendar day a model (or a date column) named. A datetime is accepted only
 * for its leading YYYY-MM-DD; the clock and zone are ignored. Null when the
 * string is not a real civil date.
 */
export function acceptCalendarDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = CIVIL_DATE.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Noon UTC: the Y-M-D is the civil date in every zone. Local midnight plus
  // toISOString is the conversion this helper exists to refuse.
  const probe = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    Number.isNaN(probe.getTime()) ||
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}
