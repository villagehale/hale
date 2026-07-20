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

/** The band of a computed WHO z-score: 'typical' when |z| ≤ 2, else 'review' (a
 * neutral "worth a look", never a diagnosis). */
export type GrowthBand = 'typical' | 'review';

/** The growth read for one measure's LATEST reading, deterministic WHO computation
 * (never LLM-derived). A discriminated union so the client renders exactly one honest
 * state per kind; a kind with no reading (or one outside WHO's 0–5y range) is simply
 * absent from the served list rather than faked.
 *  - 'assessed'      → a real z-score + band from the committed WHO LMS tables.
 *  - 'needs-details' → no usable biological sex on file, so no sex-specific standard applies.
 *  - 'preterm'       → born <37 weeks; chronological-age standards would mislead. */
export type GrowthAssessmentView =
  | { measureKind: string; state: 'assessed'; z: number; band: GrowthBand }
  | { measureKind: string; state: 'needs-details' }
  | { measureKind: string; state: 'preterm' };

/** One page of logs, newest first, with the keyset cursor for the next page. */
export interface LogsPage {
  logs: LogView[];
  /** occurredAt to page before on the next request, or null when this is the last page. */
  nextCursor: string | null;
  /** WHO growth read of each measure's latest reading. Present ONLY on a
   * single-child measurement page (the Growth tab's query); omitted for the
   * family-wide / mixed Diary read where a per-child standard can't apply. Built
   * from the already-redacted logs, so a teen's reading never contributes (rule #1). */
  growthAssessments?: GrowthAssessmentView[];
}

/** A day section of the grouped view: a stable YYYY-MM-DD key + its rows in order. */
export interface LogDayGroup {
  dayKey: string;
  logs: LogView[];
}

export const PAGE_LIMIT = 30;

/** The ordinal form of a whole number: 1 → "1st", 2 → "2nd", 42 → "42nd", 13 →
 * "13th". Handles the 11–13 exception. Pure + client-safe (lives here, not in the
 * server-only growth math) so the Companion header can render "42nd %ile" without
 * pulling the WHO tables into the browser bundle. */
export function percentileOrdinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

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
