/**
 * Client-safe shapes + pure helpers for the logs surfaces. This module has NO
 * server imports (no db, no auth), so a client component can import the grouping
 * and cursor logic without dragging the Drizzle/next-auth graph into the browser
 * bundle. The server read path (logs-page.ts) builds on these too.
 */

/** A logged episode, flattened for a logs list. The structured NUMERICS are lifted
 * from the episode payload (never the raw payload / notes) so a client can chart a
 * naps trend without a second read. Present only when the episode carries them;
 * these are the ONE deliberate widening past summary — numbers, never raw content —
 * and they still ride the shared teen-redaction read (a redacted row never reaches
 * this shape). */
export interface LogView {
  id: string;
  childId: string | null;
  episodeType: string;
  summary: string;
  /** ISO string. */
  occurredAt: string;
  /** Nap length in minutes, lifted from payload; absent on non-nap rows. */
  durationMin?: number;
  /** Feed volume in ml, lifted from payload; absent on non-feed rows. */
  amountMl?: number;
  /** Feed kind (bottle/breast/solid), lifted from payload; absent when unspecified. */
  feedKind?: string;
  /** Growth measure kind (weight/height/head), lifted from payload; absent on
   * non-measurement rows. Present only alongside value + unit (lifted as a set). */
  measureKind?: string;
  /** The measured number, lifted from payload; absent on non-measurement rows. */
  value?: number;
  /** The measurement's fixed unit (kg/cm), lifted from payload; absent otherwise. */
  unit?: string;
}

/** One page of logs, newest first, with the keyset cursor for the next page. */
export interface LogsPage {
  logs: LogView[];
  /** occurredAt to page before on the next request, or null when this is the last page. */
  nextCursor: string | null;
}

/** A day section of the grouped view: a stable YYYY-MM-DD key + its rows in order. */
export interface LogDayGroup {
  dayKey: string;
  logs: LogView[];
}

export const PAGE_LIMIT = 30;

function dayKeyOf(occurredAt: string): string {
  const d = new Date(occurredAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Buckets a flat, newest-first page into day sections, newest day first, keeping
 * each day's within-day order. Pure — the grouping the view renders. An empty page
 * yields no sections (the calm empty state, never a fabricated day).
 */
export function groupLogsByDay(logs: LogView[]): LogDayGroup[] {
  const groups: LogDayGroup[] = [];
  let current: LogDayGroup | null = null;
  for (const log of logs) {
    const key = dayKeyOf(log.occurredAt);
    if (!current || current.dayKey !== key) {
      current = { dayKey: key, logs: [] };
      groups.push(current);
    }
    current.logs.push(log);
  }
  return groups;
}

/**
 * The next keyset cursor: the last row's occurredAt when a FULL page came back (a
 * further page may exist), else null (a short/empty page is the last one). Pure.
 */
export function nextCursorFrom(logs: LogView[], limit: number): string | null {
  if (logs.length < limit) return null;
  return logs[logs.length - 1]?.occurredAt ?? null;
}
