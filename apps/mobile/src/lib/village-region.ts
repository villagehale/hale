/**
 * The Village region switcher's pure decision layer — the framework-free
 * counterpart to the area routes in apps/web/app/api/mobile/village/areas. It owns
 * the header/subtitle copy that follows the active area, the browsing↔searching mode
 * gate, the min-length + saved-exclusion rules for the city typeahead, and the
 * on-device reverse-geocode → coarse {city, province} mapper. No I/O and no RN
 * import, so it is unit-testable off-device (the RN sheet is review-only).
 *
 * Privacy (rule #1): everything here is COARSE — city + province only. The mapper
 * reads no coordinate field; precise coordinates never enter this module.
 */

import type { CityCandidate, SavedArea, SavedAreaLabel } from './api-types';

/** Minimum trimmed query length before the switcher fires a city-search request —
 * one letter would flood the typeahead, so requests are gated to >= 2 chars. Mode
 * (browsing vs searching) still switches on ANY non-empty query. */
export const MIN_QUERY_LENGTH = 2;

/** How many candidates the search-results list shows — the rest are dropped so the
 * list stays scannable. */
export const MAX_SEARCH_RESULTS = 5;

/** The Village header label: the active area's city, or the current "Near you" when
 * the family has saved no area. Never fabricates a city (the null case — verified
 * against prod data, where most families have no active area yet). */
export function headerLabel(area: SavedAreaLabel | null | undefined): string {
  return area?.city ?? 'Near you';
}

/** The Village subtitle: follows the active area's city, or the current copy
 * verbatim when there is no area. */
export function subtitleCopy(area: SavedAreaLabel | null | undefined): string {
  return area?.city
    ? `Find support, activities & resources in ${area.city}.`
    : 'Find support, activities & resources near you.';
}

export type RegionMode = 'browsing' | 'searching';

/** Which sheet mode a query selects: an empty query browses "Your areas"; any
 * non-empty query switches to "Search results" (mirrors the prototype's
 * locSearching = query.length > 0). */
export function regionMode(query: string): RegionMode {
  return query.trim().length > 0 ? 'searching' : 'browsing';
}

/** Whether a query is long enough to fire a search request (the min-length gate). A
 * shorter query is still "searching" mode but issues no request. */
export function shouldSearch(query: string): boolean {
  return query.trim().length >= MIN_QUERY_LENGTH;
}

/** Case-insensitive (city, province) identity — the same key the server dedupes on,
 * so a saved area and a candidate for the same place compare equal. */
function areaKey(city: string, province: string | null | undefined): string {
  return `${city.trim().toLowerCase()}|${(province ?? '').trim().toLowerCase()}`;
}

/** A stable feed identity for the active area — changes iff the coarse area changes.
 * The Village feed's client-side filter state (cadence + seasons) is keyed on this so a
 * city switch RESETS the filters (an "indoor" filter set in Toronto must not silently
 * carry to Vancouver), while a same-area re-fetch keeps them. Mirrors the web feed being
 * keyed on its coarse area. The no-area "Near you" feed gets its own stable key. */
export function villageFeedKey(area: SavedAreaLabel | null | undefined): string {
  return area ? areaKey(area.city, area.province) : 'near-you';
}

/** True when a saved area and a (city, province) name the same coarse place. */
export function sameArea(
  area: { city: string; province: string | null },
  city: string,
  province: string | null | undefined,
): boolean {
  return areaKey(area.city, area.province) === areaKey(city, province);
}

/** Search candidates with the family's already-saved areas removed and the list
 * capped — a place you've already saved belongs under "Your areas", not results. */
export function filterSearchResults(
  candidates: CityCandidate[],
  savedAreas: SavedArea[],
  cap: number = MAX_SEARCH_RESULTS,
): CityCandidate[] {
  const saved = new Set(savedAreas.map((a) => areaKey(a.city, a.province)));
  return candidates.filter((c) => !saved.has(areaKey(c.city, c.province))).slice(0, cap);
}

/** The row sub-line for a saved area: its human note when set, else the province,
 * else nothing (never a fabricated radius). */
export function areaSubtitle(area: SavedArea): string | null {
  return area.note ?? area.province ?? null;
}

/** The row sub-line for a search candidate: its province (the only coarse field the
 * search returns beyond the city), or nothing. */
export function candidateSubtitle(candidate: CityCandidate): string | null {
  return candidate.province ?? null;
}

/** The subset of Expo's LocationGeocodedAddress this mapper reads — kept as a
 * structural shape so the mapper stays pure and fixture-testable off-device. */
export interface ReverseGeocodeAddress {
  city?: string | null;
  region?: string | null;
  subregion?: string | null;
  district?: string | null;
}

/** A coarse place resolved on-device — city (required) plus an optional province.
 * Coordinates are intentionally NOT part of this shape (rule #1). */
export interface CoarsePlace {
  city: string;
  province: string | null;
}

function firstNonEmpty(...values: (string | null | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return null;
}

/**
 * Reduce a reverse-geocoded address to a coarse {city, province}, or null when no
 * city-like field is present (the caller then falls back to manual search). City
 * prefers `city`, then `subregion`, then `district`; province is `region`.
 * Coordinates are never read here — only coarse names leave the device (rule #1).
 */
export function cityFromReverseGeocode(
  address: ReverseGeocodeAddress | null | undefined,
): CoarsePlace | null {
  if (!address) return null;
  const city = firstNonEmpty(address.city, address.subregion, address.district);
  if (!city) return null;
  return { city, province: firstNonEmpty(address.region) };
}
