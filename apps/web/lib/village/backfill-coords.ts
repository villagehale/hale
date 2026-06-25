import { type Database, schema } from '@hale/db';
import { eq, isNull } from 'drizzle-orm';
import { type GeocodeResult, geocodeVenue } from './geocode';

/**
 * Bounded backfill of venue coordinates for EXISTING village candidates that
 * predate the map (lat is null). Runs inside the discovery cron so the map fills
 * in over time without a separate job. Each candidate is geocoded with the
 * COARSE area only (rule #1) via Places Text Search; a resolved PUBLIC venue
 * updates the row's coords, a miss leaves it null (stays list-only, never retried
 * within the same run). The cap bounds the per-run Places call volume.
 *
 * Best-effort: geocodeVenue never throws, and a candidate whose family has no
 * coarse area is skipped (we can't disambiguate without it, and the precise home
 * is never used — rule #1).
 */

/** Hard cap on geocode lookups per backfill run — the Places call blast-radius. */
export const MAX_BACKFILL_PER_RUN = 25;

export interface BackfillDeps {
  geocode: (title: string, areaCoarse: string) => Promise<GeocodeResult | null>;
}

export function defaultBackfillDeps(): BackfillDeps {
  return { geocode: (title, areaCoarse) => geocodeVenue(title, areaCoarse) };
}

export interface BackfillResult {
  scanned: number;
  geocoded: number;
}

export async function backfillCandidateCoords(
  database: Database,
  deps: BackfillDeps = defaultBackfillDeps(),
  limit: number = MAX_BACKFILL_PER_RUN,
): Promise<BackfillResult> {
  const rows = await database
    .select({
      id: schema.villageCandidates.id,
      title: schema.villageCandidates.title,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.villageCandidates)
    .innerJoin(schema.families, eq(schema.villageCandidates.familyId, schema.families.id))
    .where(isNull(schema.villageCandidates.lat))
    .limit(limit);

  let geocoded = 0;
  for (const row of rows) {
    if (!row.areaCoarse) continue;
    const coords = await deps.geocode(row.title, row.areaCoarse);
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
