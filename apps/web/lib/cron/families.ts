import { type Database, schema } from '@hale/db';
import { asc, isNotNull, or, sql } from 'drizzle-orm';

/**
 * Per-run family caps. A cron run iterates families, runs a real (token-spending)
 * agent for each, and must NEVER be able to fan out across the whole table in one
 * invocation — that is the budget blast-radius bound (the per-family spend guard
 * caps each family; this caps how many families a single run touches at all).
 *
 * The caps are deliberately small: a scheduled run processes a bounded slice;
 * the next run picks up where it left off (ordered by creation, then by the
 * staleness predicate for discovery). Raising a cap is a one-line edit here.
 */
export const MAX_FAMILIES_PER_RUN = {
  digest: 100,
  discovery: 50,
  inference: 100,
  pushReminders: 100,
} as const;

/** Discovery only runs for families whose candidate pool is stale or empty. */
const DISCOVERY_STALE_DAYS = 7;

/**
 * The bounded set of families a digest/inference run processes: oldest-first,
 * capped at `limit`. Ordering by creation gives a stable, repeatable slice (a
 * re-run sees the same families) and is index-friendly. Returns just the ids the
 * caller iterates.
 */
export async function selectFamiliesForRun(
  database: Database,
  limit: number,
): Promise<string[]> {
  const rows = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .orderBy(asc(schema.families.createdAt))
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Families whose village discovery is stale (no candidate newer than
 * DISCOVERY_STALE_DAYS) or empty (never discovered), AND that have opted into
 * local discovery by setting a coarse area (rule #1: no area → nothing to
 * discover, and discoverForFamily would short-circuit anyway). Bounded by
 * `limit`. The LEFT JOIN + MAX(discovered_at) grouping picks each family's
 * freshest candidate; a family with none has a NULL max and qualifies.
 */
export async function selectFamiliesNeedingDiscovery(
  database: Database,
  limit: number,
  now: Date = new Date(),
): Promise<string[]> {
  const staleBefore = new Date(now.getTime() - DISCOVERY_STALE_DAYS * 24 * 60 * 60 * 1000);
  const lastDiscovered = sql<Date | null>`max(${schema.villageCandidates.discoveredAt})`;

  const rows = await database
    .select({
      id: schema.families.id,
      lastDiscovered,
    })
    .from(schema.families)
    .leftJoin(
      schema.villageCandidates,
      sql`${schema.villageCandidates.familyId} = ${schema.families.id}`,
    )
    .where(isNotNull(schema.families.areaCoarse))
    .groupBy(schema.families.id, schema.families.createdAt)
    .having(
      or(
        sql`${lastDiscovered} IS NULL`,
        // Bind the cutoff as an ISO string + cast: the left side is a sql fragment
        // (max(...)), so Drizzle can't infer the param type and would pass a raw
        // Date to postgres.js (which throws). A string param casts cleanly.
        sql`${lastDiscovered} < ${staleBefore.toISOString()}::timestamptz`,
      ),
    )
    .orderBy(asc(schema.families.createdAt))
    .limit(limit);

  return rows.map((r) => r.id);
}
