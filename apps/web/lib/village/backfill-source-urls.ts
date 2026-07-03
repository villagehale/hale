import { type Database, schema } from '@hale/db';
import { eq, isNull, or } from 'drizzle-orm';
import { type GeocodeResult, geocodeVenue } from './geocode';

/**
 * One-off backfill of source_url for EXISTING village candidates. Two modes:
 *
 *  - default: fill candidates whose source_url is null/empty by re-running the
 *    Places lookup and adopting the resolved venue website — for rows discovered
 *    before we captured the website from Places.
 *  - force: scan EVERY candidate (including rows that already have a url) and,
 *    when Places resolves a real venue website, REPLACE the stored url with it.
 *    This corrects rows whose current url is a model-supplied guess (discovery
 *    used to prefer the model url over the verified Places site). Run by hand,
 *    not on the cron, because re-checking every row multiplies Places call volume.
 *
 * Both use the SAME inputs geocodeVenue uses — the candidate title + the family's
 * COARSE area (rule #1) — and never blank an existing url: a venue with no website
 * leaves the row unchanged (its register link keeps its current url or the
 * Google-search fallback).
 *
 * Idempotent: force re-resolves the same Places website each run, so a second run
 * sets the same value; default only selects rows still lacking a url. Best-effort:
 * geocodeVenue never throws (rule #8 boundary), and a candidate whose family has
 * no coarse area is skipped (we can't disambiguate without it, and the precise
 * home is never used — rule #1).
 */

/** Hard cap on Places lookups per backfill run — the Places call blast-radius. */
export const MAX_BACKFILL_PER_RUN = 50;

export interface BackfillSourceUrlDeps {
  geocode: (title: string, areaCoarse: string) => Promise<GeocodeResult | null>;
}

export function defaultBackfillSourceUrlDeps(): BackfillSourceUrlDeps {
  return { geocode: (title, areaCoarse) => geocodeVenue(title, areaCoarse) };
}

export interface BackfillSourceUrlOptions {
  /** Also re-resolve rows that already have a url and replace it with the verified
   * Places website (to correct model-guessed urls). Off by default so the cheap
   * fill-only path stays the default. */
  force?: boolean;
}

export interface BackfillSourceUrlResult {
  scanned: number;
  updated: number;
}

export async function backfillCandidateSourceUrls(
  database: Database,
  deps: BackfillSourceUrlDeps = defaultBackfillSourceUrlDeps(),
  options: BackfillSourceUrlOptions = {},
): Promise<BackfillSourceUrlResult> {
  const { force = false } = options;

  const rows = await database
    .select({
      id: schema.villageCandidates.id,
      title: schema.villageCandidates.title,
      areaCoarse: schema.families.areaCoarse,
    })
    .from(schema.villageCandidates)
    .innerJoin(schema.families, eq(schema.villageCandidates.familyId, schema.families.id))
    .where(
      force
        ? undefined
        : or(isNull(schema.villageCandidates.sourceUrl), eq(schema.villageCandidates.sourceUrl, '')),
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
