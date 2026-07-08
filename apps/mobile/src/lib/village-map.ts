/**
 * Pure, native-import-free logic for the Village map surface, split out so the
 * vitest runner (which cannot parse react-native / expo-maps native code) can test
 * the decision of WHAT to render without importing either.
 *
 * The interactive map plots exactly ONE point: the candidate's already-resolved
 * PUBLIC venue coordinate (a library, a pool) — never the family's location
 * (rule #1). A candidate with no coordinate (an online / no-venue activity, an
 * unresolved geocode, or a teen-redacted card whose lat/lng are nulled at the
 * mapper) has no pin, so no interactive map is shown.
 */

export interface MapPoint {
  lat: number;
  lng: number;
  /** The public venue's label for the marker callout, or null → the marker shows
   * no title (never a fabricated name). */
  title: string | null;
}

/**
 * Resolve the single map marker for a candidate, or null when there is nothing to
 * plot. Coordinates must BOTH be present (a half-resolved geocode never plots a
 * pin at the equator). Returns the public venue point + its label.
 */
export function mapPointFor(candidate: {
  lat: number | null;
  lng: number | null;
  venueName: string | null;
  title: string;
}): MapPoint | null {
  if (candidate.lat === null || candidate.lng === null) return null;
  return {
    lat: candidate.lat,
    lng: candidate.lng,
    title: candidate.venueName ?? candidate.title,
  };
}

/** A tight default zoom for a single-venue map — neighbourhood level, matching the
 * static thumbnail's zoom so the interactive and static surfaces read the same. */
export const VILLAGE_MAP_ZOOM = 15;
