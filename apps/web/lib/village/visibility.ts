import { DEFAULT_TIMEZONE, dayKeyOf } from '~/lib/format/datetime';
import type { VillageCandidate } from './mappers';

/**
 * The feed's visibility contract, pure over a candidate row + a fixed `now`. It is
 * the one place that decides whether a discovered activity still belongs on the
 * feed, so the rule can never drift between the server filter and any future
 * surface. No clock, no DB, no timezone guessing beyond the family's zone passed
 * in — every decision is a deterministic function of the row and the moment.
 *
 * A run is REPLACED, not accumulated (discover soft-stamps supersededAt), so this
 * filter only ever sees the current run; on top of that it drops rows that have
 * aged out of relevance:
 *   - superseded → hidden (defence in depth; the query already filters it).
 *   - the whole run is stale (older than the freshness window) → the run is
 *     EXPIRED and every row hides, so the feed shows the find-fresh empty state
 *     rather than last month's picks.
 *   - a one-time / dated event whose day has passed → dropped the day AFTER it.
 *   - a seasonal activity out of its season → hidden until the season returns.
 *   - ongoing / year-round / unclassified → visible while the run is fresh.
 */

export const SEASONS = ['spring', 'summer', 'fall', 'winter'] as const;
export type Season = (typeof SEASONS)[number];

/** Discovery runs go stale after two weeks — past that the feed reads as last
 * month's activities, so the whole run is treated as expired and the family is
 * pushed to re-run discovery (the find-fresh empty state) instead of shown rows
 * that may already be over. */
export const RUN_FRESH_DAYS = 14;

/** Canada, calendar (wall-clock) seasons by month: spring Mar–May, summer Jun–Aug,
 * fall Sep–Nov, winter Dec–Feb. Derived from the month in the family's zone so a
 * late-night visit near a month boundary reads its local month, not UTC's. */
export function seasonOf(now: Date, timeZone: string = DEFAULT_TIMEZONE): Season {
  const month = Number(
    new Intl.DateTimeFormat('en-CA', { month: 'numeric', timeZone }).format(now),
  );
  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'fall';
  return 'winter';
}

/** True while the run `discoveredAt` sits within the freshness window ending at
 * `now`. A future stamp (clock skew) is treated as fresh. */
export function isRunFresh(
  discoveredAt: Date,
  now: Date,
  freshDays: number = RUN_FRESH_DAYS,
): boolean {
  const ageMs = now.getTime() - discoveredAt.getTime();
  return ageMs <= freshDays * 24 * 60 * 60 * 1000;
}

/**
 * Whether a candidate should appear on the feed at `now`. Pure; see the module
 * doc for the full contract. `timeZone` is the family's zone so both the season
 * and the "today" a dated event is compared against are the family's local day,
 * never the server's (UTC) day.
 */
export function isVisibleNow(
  candidate: VillageCandidate,
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): boolean {
  if (candidate.supersededAt !== null) return false;
  if (!isRunFresh(candidate.discoveredAt, now)) return false;

  // A dated event is gated by its day regardless of cadence: a row the model
  // dated is dropped the day after, so a mislabelled ongoing series can't leak a
  // past date. event_date is a bare calendar day; compare it against the family's
  // local day (YYYY-MM-DD sorts lexically).
  if (candidate.eventDate !== null) {
    return candidate.eventDate >= dayKeyOf(now, timeZone);
  }

  if (candidate.cadence === 'seasonal' && candidate.seasons !== null) {
    return candidate.seasons.includes(seasonOf(now, timeZone));
  }

  return true;
}

/** Keep only the candidates visible at `now` (see isVisibleNow). Preserves the
 * caller's order — the confidence order the DB already applied. */
export function visibleCandidates<T extends VillageCandidate>(
  candidates: readonly T[],
  now: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): T[] {
  return candidates.filter((c) => isVisibleNow(c, now, timeZone));
}

/** Float dated (event_date) picks to the front, soonest-first, so a time-boxed
 * event reads before the standing options; undated rows keep their incoming order
 * behind them. Stable, so the confidence order survives within each group. */
export function orderByDate<T extends { eventDate: string | null }>(candidates: readonly T[]): T[] {
  const dated = candidates
    .filter((c) => c.eventDate !== null)
    .sort((a, b) => (a.eventDate as string).localeCompare(b.eventDate as string));
  const undated = candidates.filter((c) => c.eventDate === null);
  return [...dated, ...undated];
}
