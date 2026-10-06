/**
 * How `search_village` narrows a date-window set by the parent's words.
 *
 * A literal substring of the whole query ("Saturday kids activities") misses a
 * Saturday story time whose title never contains that phrase, and the tool then
 * reports an empty list and `inVerification: 0`. The match is token-wise instead:
 * day and time words select by the candidate's date, generic words are ignored,
 * and any remaining word may hit the title or the summary. When those words
 * match nothing, the date-window set is what gets returned — an open "what's on"
 * question is not an empty neighbourhood.
 *
 * Pure on purpose. The coach-channel eval imports this file (it cannot resolve
 * the `~/` alias) so the fixture applies the same filter the tool does.
 */

export interface VillageMatchRow {
  title: string;
  summary: string;
  /** Bare calendar day `YYYY-MM-DD`, or null when the find has no date yet. */
  eventDate: string | null;
}

/** Sunday = 0, matching `Date#getUTCDay`. A civil `YYYY-MM-DD` is not an instant. */
const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  dimanche: 0,
  lundi: 1,
  mardi: 2,
  mercredi: 3,
  jeudi: 4,
  vendredi: 5,
  samedi: 6,
};

/** Dropped before matching. A day word selects by `eventDate`; it is not a title word. */
const DAY_TIME_WORDS = new Set<string>([
  ...Object.keys(WEEKDAYS),
  'weekend',
  'weekday',
  'today',
  'tomorrow',
  'tonight',
  'week',
  'morning',
  'afternoon',
  'evening',
  'night',
  'noon',
]);

/**
 * Words a parent uses to ask the question, not to name the activity. "Saturday
 * kids activities" has no activity word left once these and the day are gone.
 */
const GENERIC_WORDS = new Set<string>([
  'kids',
  'kid',
  'activities',
  'activity',
  'things',
  'thing',
  'anything',
  'on',
  'for',
  'something',
  'stuff',
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function contentTokens(query: string): string[] {
  return tokenize(query).filter((token) => !DAY_TIME_WORDS.has(token) && !GENERIC_WORDS.has(token));
}

/** Weekdays named in the query. `weekend` is Saturday and Sunday. No day named → null. */
export function askedWeekdays(query: string): number[] | null {
  const days = new Set<number>();
  for (const token of tokenize(query)) {
    const weekday = WEEKDAYS[token];
    if (weekday !== undefined) days.add(weekday);
    if (token === 'weekend') {
      days.add(6);
      days.add(0);
    }
  }
  return days.size === 0 ? null : [...days];
}

/**
 * Weekday of a bare calendar day, or null when the month is missing.
 * UTC so the civil date cannot shift. A null means the row is not that day.
 */
export function weekdayOfEventDate(eventDate: string): number | null {
  const [year, month, day] = eventDate.split('-').map(Number);
  if (year === undefined || month === undefined) return null;
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function onAskedDay(row: VillageMatchRow, days: readonly number[] | null): boolean {
  if (days === null) return true;
  // No date yet: not some other day. It stays in the set so `inVerification`
  // still counts a find the day filter cannot place.
  if (row.eventDate === null || row.eventDate === '') return true;
  const weekday = weekdayOfEventDate(row.eventDate);
  if (weekday === null) return false;
  return days.includes(weekday);
}

function rowHasToken(row: VillageMatchRow, token: string): boolean {
  const words = tokenize(`${row.title} ${row.summary}`);
  return words.some((word) => word === token || (token.length >= 3 && word.startsWith(token)));
}

/**
 * Narrow `rows` by `query`.
 *
 * `rows` is already the date window for this family's area (the caller applied
 * that). A named day then keeps rows whose `eventDate` falls on it. Remaining
 * tokens match any-of against title or summary. Zero text hits with a non-empty
 * window falls back to that window — still day-scoped when a day was asked.
 */
export function filterVillageRows<T extends VillageMatchRow>(
  rows: readonly T[],
  query: string | undefined,
): T[] {
  const text = typeof query === 'string' ? query.trim() : '';
  const days = text === '' ? null : askedWeekdays(text);
  const windowed = rows.filter((row) => onAskedDay(row, days));
  if (text === '') return windowed;

  const tokens = contentTokens(text);
  if (tokens.length === 0) return windowed;

  const matched = windowed.filter((row) => tokens.some((token) => rowHasToken(row, token)));
  if (matched.length === 0 && windowed.length > 0) return windowed;
  return matched;
}
