import { type Database, schema } from '@hale/db';
import { eq, isNull, or } from 'drizzle-orm';
import { type GeocodeResult, geocodeVenue } from './geocode';

/**
 * One-off backfill of source_url for EXISTING village candidates discovered before
 * we captured the venue website from Places. For each candidate whose source_url
 * is null/empty, re-run the Places lookup (the SAME inputs geocodeVenue uses — the
 * candidate title + the family's COARSE area, rule #1) and adopt the resolved
 * venue website. A venue with no website is left null (the register link's
 * Google-search fallback stays correct for the rare truly-no-website case).
 *
 * Idempotent: the query only selects candidates that still lack a url, so a
 * second run skips everything the first run filled; an LLM-supplied url is never
 * touched. Best-effort: geocodeVenue never throws (rule #8 boundary), and a
 * candidate whose family has no coarse area is skipped (we can't disambiguate
 * without it, and the precise home is never used — rule #1).
 */

/** Hard cap on Places lookups per backfill run — the Places call blast-radius. */
export const MAX_BACKFILL_PER_RUN = 50;

export interface BackfillSourceUrlDeps {
  geocode: (title: string, areaCoarse: string) => Promise<GeocodeResult | null>;
}

export function defaultBackfillSourceUrlDeps(): BackfillSourceUrlDeps {
  return { geocode: (title, areaCoarse) => geocodeVenue(title, areaCoarse) };
}

export interface BackfillSourceUrlResult {
  scanned: number;
  updated: number;
}

export async function backfillCandidateSourceUrls(
  database: Database,
  deps: BackfillSourceUrlDeps = defaultBackfillSourceUrlDeps(),
): Promise<BackfillSourceUrlResult> {
  const rows = await database
    .select({
      id: schema.villageCandidates.id,
      title: schema.villageCandidates.title,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.villageCandidates)
    .innerJoin(schema.families, eq(schema.villageCandidates.familyId, schema.families.id))
    .where(
      or(isNull(schema.villageCandidates.sourceUrl), eq(schema.villageCandidates.sourceUrl, '')),
    )
    .limit(MAX_BACKFILL_PER_RUN);

  let updated = 0;
  for (const row of rows) {
    if (!row.areaCoarse) continue;
    const venue = await deps.geocode(row.title, row.areaCoarse);
    if (!venue?.website) continue;
    await database
      .update(schema.villageCandidates)
      .set({ sourceUrl: venue.website })
      .where(eq(schema.villageCandidates.id, row.id));
    updated += 1;
  }

  return { scanned: rows.length, updated };
}
