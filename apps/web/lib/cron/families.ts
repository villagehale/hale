import { type Database, schema } from '@hale/db';
import { asc } from 'drizzle-orm';

/**
 * Per-run family caps. A cron run iterates families, runs a real (token-spending)
 * agent for each, and must NEVER be able to fan out across the whole table in one
 * invocation — that is the budget blast-radius bound (the per-family spend guard
 * caps each family; this caps how many families a single run touches at all).
 *
 * The caps are deliberately small: a scheduled run processes a bounded slice;
 * the next run picks up where it left off (ordered by creation). Raising a cap
 * is a one-line edit here.
 */
export const MAX_FAMILIES_PER_RUN = {
  inference: 100,
  pushReminders: 100,
  /** The civic sweep's per-run projection bound. Its INGEST cost is fixed (one
   * pass over the public calendars regardless of headcount); this caps only the
   * per-family database work. */
  civicSweep: 200,
  /** Memory digests are deterministic, but a bad rule still has to be bounded. */
  memoryDigest: 50,
} as const;

/**
 * The bounded set of families a digest/inference run processes: oldest-first,
 * capped at `limit`. Ordering by creation gives a stable, repeatable slice (a
 * re-run sees the same families) and is index-friendly. Returns just the ids the
 * caller iterates.
 */
export async function selectFamiliesForRun(database: Database, limit: number): Promise<string[]> {
  const rows = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .orderBy(asc(schema.families.createdAt))
    .limit(limit);
  return rows.map((r) => r.id);
}
