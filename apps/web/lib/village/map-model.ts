import type { VillageCandidateView } from './mappers';

/**
 * Pure map-model builder for the village map view — the testable seam behind the
 * client map component (the component itself only translates this into Google
 * Maps markers). Given the AGENT-RANKED candidate views plus the family's COARSE
 * area centroid, it decides what gets a pin and where the map centers.
 *
 * Privacy (rule #1):
 *  - A marker is plotted ONLY for a PUBLIC venue location (lat/lng on the
 *    candidate). The family's precise home has no coordinates anywhere, so it can
 *    never become a marker.
 *  - The map centers on the COARSE-area centroid (FSA / city), never a precise
 *    home. When markers exist the view fits their bounds (public venues only);
 *    the coarse centroid remains the fallback center with no markers.
 *  - A teen-redacted candidate (teenAttributed) is NEVER given a pin: surfacing
 *    its location on a map would expose more than the category-only the list
 *    shows. It stays list-only.
 *
 * Ranking (preserved): markers keep loadVillageFeed's ranked order — the map is a
 * spatial companion to the SAME ranked feed, not a re-ranking.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

export interface VillageMarker {
  id: string;
  position: LatLng;
  title: string;
}

export interface VillageMapModel {
  /** One marker per plottable candidate, in the ranked order received. */
  markers: VillageMarker[];
  /** Where to center when there are no markers to fit — the coarse-area centroid,
   * or null when the coarse area itself couldn't be resolved. Never a precise home. */
  center: LatLng | null;
  /** How many ranked candidates have no pin (online / no-venue / unresolved /
   * teen-redacted) — drives the "N more in the list" affordance. */
  listOnlyCount: number;
}

/**
 * A candidate is plottable iff it is a non-teen card carrying PUBLIC venue
 * coordinates. Teen-redacted cards and coordless cards are list-only.
 */
function isPlottable(
  c: VillageCandidateView,
): c is VillageCandidateView & { lat: number; lng: number } {
  return !c.teenAttributed && typeof c.lat === 'number' && typeof c.lng === 'number';
}

export function buildVillageMapModel(
  candidates: VillageCandidateView[],
  coarseCenter: LatLng | null,
): VillageMapModel {
  const markers: VillageMarker[] = [];
  for (const c of candidates) {
    if (isPlottable(c)) {
      markers.push({ id: c.id, position: { lat: c.lat, lng: c.lng }, title: c.title });
    }
  }
  return {
    markers,
    center: coarseCenter,
    listOnlyCount: candidates.length - markers.length,
  };
}
