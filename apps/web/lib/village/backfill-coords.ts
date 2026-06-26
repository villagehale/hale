import { type Database, schema } from '@hale/db';
import { eq, isNull } from 'drizzle-orm';
import { type GeocodeResult, type LatLng, geocodeArea, geocodeVenue } from './geocode';

/**
 * Bounded backfill of venue coordinates for EXISTING village candidates. By
 * default it fills only candidates that predate the map (lat is null), so the map
 * fills in over time from inside the discovery cron. With `force`, it RE-geocodes
 * candidates that already have coords too — to correct pins that landed in the
 * wrong city before venue lookups were biased to the family's coarse area. That
 * one-off is run by hand (not on the cron) because re-geocoding every candidate
 * each run would multiply the cron's Places call volume.
 *
 * Every lookup is biased to the family's COARSE-area centre (rule #1) so a
 * same-named venue in another city doesn't win the pin. The centre is resolved
 * once per distinct coarse area within a run. A resolved PUBLIC venue updates the
 * row's coords; a miss leaves the row unchanged.
 *
 * Best-effort: geocodeVenue / geocodeArea never throw, and a candidate whose
 * family has no coarse area is skipped (we can't disambiguate without it, and the
 * precise home is never used — rule #1).
 */

/** Hard cap on geocode lookups per backfill run — the Places call blast-radius. */
export const MAX_BACKFILL_PER_RUN = 50;

export interface BackfillDeps {
  geocode: (title: string, areaCoarse: string, bias?: LatLng) => Promise<GeocodeResult | null>;
  geocodeArea: (areaCoarse: string) => Promise<LatLng | null>;
}

export function defaultBackfillDeps(): BackfillDeps {
  return {
    geocode: (title, areaCoarse, bias) => geocodeVenue(title, areaCoarse, undefined, bias),
    geocodeArea: (areaCoarse) => geocodeArea(areaCoarse),
  };
}

export interface BackfillOptions {
  limit?: number;
  /** Re-geocode candidates that already have coords (to correct wrong-city pins),
   * not just those with a null lat. Off by default so the cron stays cheap. */
  force?: boolean;
}

export interface BackfillResult {
  scanned: number;
  geocoded: number;
}

export async function backfillCandidateCoords(
  database: Database,
  deps: BackfillDeps = defaultBackfillDeps(),
  options: BackfillOptions = {},
): Promise<BackfillResult> {
  const { limit = MAX_BACKFILL_PER_RUN, force = false } = options;

  const rows = await database
    .select({
      id: schema.villageCandidates.id,
      title: schema.villageCandidates.title,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.villageCandidates)
    .innerJoin(schema.families, eq(schema.villageCandidates.familyId, schema.families.id))
    .where(force ? undefined : isNull(schema.villageCandidates.lat))
    .limit(limit);

  // One area-centre lookup per distinct coarse area, reused across that area's
  // candidates so a run with N candidates in one area costs one area geocode, not
  // N (rule #1: coarse area only).
  const centerByArea = new Map<string, LatLng | null>();
  const biasFor = async (areaCoarse: string): Promise<LatLng | undefined> => {
    if (!centerByArea.has(areaCoarse)) {
      centerByArea.set(areaCoarse, await deps.geocodeArea(areaCoarse));
    }
    return centerByArea.get(areaCoarse) ?? undefined;
  };

  let geocoded = 0;
  for (const row of rows) {
    if (!row.areaCoarse) continue;
    const coords = await deps.geocode(row.title, row.areaCoarse, await biasFor(row.areaCoarse));
    if (!coords) continue;
    await database
      .update(schema.villageCandidates)
      .set({
        lat: coords.lat,
        lng: coords.lng,
        venueName: coords.venueName,
        venueAddress: coords.venueAddress,
      })
      .where(eq(schema.villageCandidates.id, row.id));
    geocoded += 1;
  }

  return { scanned: rows.length, geocoded };
}
