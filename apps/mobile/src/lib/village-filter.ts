import type { VillageCandidateView } from './api-types';

/**
 * The Village feed's cadence layer, mirrored from the web
 * (`apps/web/lib/village/mappers.ts`). The native bundle can't import server code,
 * so this is a hand-copied replica of the web-tested logic — keep them in step.
 * All display-only: it narrows rows the server already visibility-filtered, so it
 * issues no request and reveals no new location signal (rule #1).
 */

/** The cadence selections the feed offers. "year-round" is the human label for the
 * stored `ongoing` cadence — a stored token never renders raw (rule #1). */
export type CadenceFilter = 'all' | 'one-time' | 'seasonal' | 'year-round';

/** The four selections in feed order: everything, then the time-boxed shapes
 * (one-time, seasonal) before the standing option (year-round). */
export const CADENCE_OPTIONS: ReadonlyArray<{ value: CadenceFilter; label: string }> = [
  { value: 'all', label: 'all' },
  { value: 'one-time', label: 'one-time' },
  { value: 'seasonal', label: 'seasonal' },
  { value: 'year-round', label: 'year-round' },
];

const CADENCE_FILTER_MATCH: Record<Exclude<CadenceFilter, 'all'>, string> = {
  'one-time': 'one-time',
  seasonal: 'seasonal',
  'year-round': 'ongoing',
};

/** Narrow the feed to one cadence. "all" keeps everything; any specific selection
 * keeps only rows whose stored cadence maps to it (so an unclassified null-cadence
 * row shows under "all" only). Mirrors web `filterCandidatesByCadence`. */
export function filterByCadence(
  candidates: VillageCandidateView[],
  filter: CadenceFilter,
): VillageCandidateView[] {
  if (!Array.isArray(candidates)) return [];
  if (filter === 'all') return candidates;
  const wanted = CADENCE_FILTER_MATCH[filter];
  return candidates.filter((c) => c.cadence === wanted);
}

/** The four seasons a loaded row can carry. This FILTERS already-loaded rows
 * client-side (no request, no LLM run) — distinct from the season SEARCH that
 * triggers a fresh discovery run (village-search.ts). */
export const SEASON_FILTER_KEYS = ['spring', 'summer', 'fall', 'winter'] as const;
export type SeasonFilterKey = (typeof SEASON_FILTER_KEYS)[number];

/**
 * Narrow the loaded feed to a SET of selected seasons (client-side, over rows the
 * server already visibility-filtered — no request, no new location signal, rule #1).
 * An empty selection narrows nothing. A row matches when its `seasons` array overlaps
 * the selection; a season-less row (one-time / ongoing / unclassified) is kept ONLY
 * when no season is selected — a season filter is a positive narrow, so a season-less
 * row can't satisfy it.
 */
export function filterBySeasons(
  candidates: VillageCandidateView[],
  selected: ReadonlySet<SeasonFilterKey>,
): VillageCandidateView[] {
  if (!Array.isArray(candidates)) return [];
  if (selected.size === 0) return candidates;
  return candidates.filter((c) => c.seasons?.some((s) => selected.has(s as SeasonFilterKey)));
}

/** Apply both filter axes (cadence, then seasons) in one pass — the loaded feed's
 * client-side narrow behind the Filters sheet. */
export function applyFilters(
  candidates: VillageCandidateView[],
  cadence: CadenceFilter,
  seasons: ReadonlySet<SeasonFilterKey>,
): VillageCandidateView[] {
  return filterBySeasons(filterByCadence(candidates, cadence), seasons);
}

/** How many filter axes are active — drives the count badge on the Filters trigger.
 * Cadence counts when it isn't "all"; seasons count as one axis when any is picked. */
export function activeFilterCount(
  cadence: CadenceFilter,
  seasons: ReadonlySet<SeasonFilterKey>,
): number {
  return (cadence === 'all' ? 0 : 1) + (seasons.size > 0 ? 1 : 0);
}

/** A card's cadence → its chip treatment (label + tint classes). Meaning is carried
 * by label + shape, never colour alone (rule #1 / DESIGN.md). Mirrors web
 * CADENCE_PILL: seasonal = time-boxed (apricot tint), one-time = single event (sky),
 * ongoing = standing option (raised). Null / unrecognised cadence → no chip. */
const CADENCE_CHIP: Record<string, { label: string; bg: string; text: string }> = {
  seasonal: { label: 'seasonal', bg: 'bg-accent-tint', text: 'text-accent' },
  'one-time': { label: 'one-time', bg: 'bg-sky-tint', text: 'text-sky' },
  ongoing: { label: 'ongoing', bg: 'bg-raised', text: 'text-ink-2' },
};

export function cadenceChip(
  cadence: string | null,
): { label: string; bg: string; text: string } | null {
  return cadence ? (CADENCE_CHIP[cadence] ?? null) : null;
}
