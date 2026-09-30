/**
 * Cheap pre-filter for Google Calendar items on the classify path.
 *
 * A first sync classifies the whole calendar. Most of those items have already
 * ended, and the classifier's answer for them is a low-confidence drop — a model
 * call that cannot produce an action the family can still take. Future items,
 * items still in progress, and anything whose time we cannot read still go to
 * the classifier. Gmail and every other source are untouched.
 */

export const GCAL_PAST_CLASSIFY_SKIP_ENV = 'GCAL_PAST_CLASSIFY_SKIP';

/** How long after a timed item's end (or start, when there is no end) before
 * the classifier is skipped. A visit that ended this afternoon still classifies. */
export const GCAL_TIMED_SKIP_AFTER_MS = 24 * 60 * 60 * 1000;

/** All-day events use an exclusive UTC date. Two days of slack so a household
 * west of UTC is not treated as finished while that calendar day is still on. */
export const GCAL_ALL_DAY_SKIP_BUFFER_DAYS = 2;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Default ON. The literal `false` (surrounding whitespace trimmed, so a trailing
 * newline from `echo` still disables) sends ended calendar items through the
 * classifier again.
 */
export function gcalPastClassifySkipEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[GCAL_PAST_CLASSIFY_SKIP_ENV]?.trim() !== 'false';
}

interface CalendarPoint {
  dateTime?: string;
  date?: string;
}

function calendarPoint(value: unknown): CalendarPoint | null {
  if (typeof value !== 'object' || value === null) return null;
  const point = value as { dateTime?: unknown; date?: unknown };
  const dateTime =
    typeof point.dateTime === 'string' && point.dateTime.length > 0 ? point.dateTime : undefined;
  const date =
    typeof point.date === 'string' && DATE_ONLY.test(point.date) ? point.date : undefined;
  if (!dateTime && !date) return null;
  return { dateTime, date };
}

/**
 * True when a `gcal` item has already ended and classifying it cannot yield an
 * action the family can still take.
 *
 * Timed: end (else start) is at least {@link GCAL_TIMED_SKIP_AFTER_MS} before
 * `now`. All-day: Google's exclusive `end.date` is at least
 * {@link GCAL_ALL_DAY_SKIP_BUFFER_DAYS} UTC days before today.
 *
 * Missing or unparseable times return false — the classifier still runs.
 */
export function gcalItemAlreadyEnded(payload: Record<string, unknown>, now: Date): boolean {
  const point = calendarPoint(payload.end) ?? calendarPoint(payload.start);
  if (!point) return false;

  if (point.dateTime) {
    const at = Date.parse(point.dateTime);
    if (Number.isNaN(at)) return false;
    return now.getTime() - at >= GCAL_TIMED_SKIP_AFTER_MS;
  }

  if (!point.date) return false;
  const exclusive = Date.parse(`${point.date}T00:00:00.000Z`);
  if (Number.isNaN(exclusive)) return false;
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = todayUtc - GCAL_ALL_DAY_SKIP_BUFFER_DAYS * 86_400_000;
  return exclusive <= cutoff;
}
