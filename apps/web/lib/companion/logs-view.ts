/**
 * Client-safe shapes + pure helpers for the logs surfaces. This module has NO
 * server imports (no db, no auth), so a client component can import the grouping
 * and cursor logic without dragging the Drizzle/next-auth graph into the browser
 * bundle. The server read path (logs-page.ts) builds on these too.
 */

/** A logged episode, flattened for a logs list. */
export interface LogView {
  id: string;
  childId: string | null;
  episodeType: string;
  summary: string;
  /** ISO string. */
  occurredAt: string;
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
