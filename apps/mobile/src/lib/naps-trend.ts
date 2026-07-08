import type { LogView } from './api-types';

/** One day's total nap minutes for the trend bars. `dayKey` is a stable local
 * YYYY-MM-DD; `label` is its short weekday ("Mon"); `totalMin` sums that day's
 * naps. `hasData` is false for a day with no naps (a gap, drawn as a baseline
 * tick — never a fabricated bar). `loaded` is false for a day OLDER than the
 * fetched page's coverage — its rows may exist but weren't read, so it is drawn as
 * "not loaded" (distinct from a known-zero "no naps" day — never claimed as empty). */
export interface NapDay {
  dayKey: string;
  label: string;
  totalMin: number;
  hasData: boolean;
  loaded: boolean;
}

/** The trend the sheet renders: the last 7 local days oldest→newest, each with its
 * summed nap minutes, plus the peak (for scaling bar heights) and whether there is
 * enough signal to draw. Below MIN_DAYS_WITH_DATA distinct LOADED days, `enough` is
 * false and the sheet shows calm empty copy instead of a one-bar chart. */
export interface NapsTrend {
  days: NapDay[];
  /** The largest single-day total, for scaling bars; 0 when no naps at all. */
  peakMin: number;
  /** True only when at least MIN_DAYS_WITH_DATA distinct LOADED days carry nap data. */
  enough: boolean;
  /** True when the window has a day older than the fetched coverage (a "not loaded"
   * gap) — the sheet then labels the trend as covering only the loaded span so it
   * never claims a full 7 days it didn't read. */
  partial: boolean;
}

const TREND_DAYS = 7;
/** Fewer distinct days than this and a "trend" is really a single point — show the
 * empty state rather than mislead with one bar (task: label the axis honestly). */
export const MIN_DAYS_WITH_DATA = 3;

function localDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * Buckets nap logs into the last 7 local days (oldest→newest), summing durationMin
 * per day. Pure — no I/O, `now` injected so it's deterministic. Only rows with an
 * episodeType of 'nap' AND a numeric durationMin contribute (a nap logged before
 * the widening, or any other kind, is ignored rather than counted as zero). Days
 * outside the 7-day window are dropped; a day inside it with no naps is kept as a
 * gap (hasData false) so the axis reads continuously.
 *
 * `coveredSince` is the oldest instant the caller actually READ (the fetched page's
 * oldest row) when more pages remain — a day older than its local day is marked
 * `loaded: false` ("not loaded"), NOT a known-zero "no naps" day, so the trend never
 * claims empty a day it never read. Omit it (or pass undefined) when the whole
 * history was fetched (nextCursor null) — then every window day is loaded.
 */
export function computeNapsTrend(
  logs: LogView[],
  now: Date = new Date(),
  coveredSince?: Date,
): NapsTrend {
  const totals = new Map<string, number>();
  for (const log of logs) {
    if (log.episodeType !== 'nap' || typeof log.durationMin !== 'number') continue;
    const key = localDayKey(new Date(log.occurredAt));
    totals.set(key, (totals.get(key) ?? 0) + log.durationMin);
  }

  const coveredKey = coveredSince ? localDayKey(coveredSince) : null;
  const days: NapDay[] = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dayKey = localDayKey(d);
    // Strictly AFTER the boundary day: the page can end mid-day, so the oldest
    // fetched row's own day may be a partial sum — treat it as not loaded
    // rather than render a quietly under-counted bar.
    const loaded = coveredKey === null || dayKey > coveredKey;
    days.push({
      dayKey,
      label: WEEKDAY_LABELS[d.getDay()],
      totalMin: loaded ? (totals.get(dayKey) ?? 0) : 0,
      hasData: loaded && totals.has(dayKey),
      loaded,
    });
  }

  const peakMin = days.reduce((max, day) => Math.max(max, day.totalMin), 0);
  const daysWithData = days.filter((day) => day.hasData).length;
  const partial = days.some((day) => !day.loaded);
  return { days, peakMin, enough: daysWithData >= MIN_DAYS_WITH_DATA, partial };
}
