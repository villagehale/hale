import { type Database, schema } from '@hale/db';
import { and, asc, eq, sql } from 'drizzle-orm';

/**
 * Per-run family caps. A cron run iterates families, runs a real (token-spending)
 * agent for each, and must NEVER be able to fan out across the whole table in one
 * invocation — that is the budget blast-radius bound (the per-family spend guard
 * caps each family; this caps how many families a single run touches at all).
 *
 * The caps are deliberately small: a scheduled run processes a bounded slice, and
 * {@link selectFamiliesForRun} rotates the slice so every family is reached within
 * ceil(families / cap) runs. Raising a cap is a one-line edit here.
 */
export const MAX_FAMILIES_PER_RUN = {
  inference: 100,
  /** Memory digests are deterministic, but a bad rule still has to be bounded. */
  memoryDigest: 50,
} as const;

/** Each bounded sweep keeps its own rotation in `family_sweep_marks`. */
export type FamilySweep = 'inference' | 'memory_digest';

/**
 * The bounded set of families a sweep processes this run: families this sweep has
 * never taken first, then the ones it took longest ago, ties broken by creation. The
 * chosen families are stamped before the caller works on them, so a family whose run
 * fails or does nothing still moves to the back of the line instead of holding a slot
 * every night.
 */
export async function selectFamiliesForRun(
  database: Database,
  sweep: FamilySweep,
  limit: number,
  now: Date,
): Promise<string[]> {
  const rows = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .leftJoin(
      schema.familySweepMarks,
      and(
        eq(schema.familySweepMarks.familyId, schema.families.id),
        eq(schema.familySweepMarks.sweep, sweep),
      ),
    )
    .orderBy(
      sql`${schema.familySweepMarks.sweptAt} asc nulls first`,
      asc(schema.families.createdAt),
      asc(schema.families.id),
    )
    .limit(limit);
  const ids = rows.map((r) => r.id);
  if (ids.length === 0) return ids;

  await database
    .insert(schema.familySweepMarks)
    .values(ids.map((familyId) => ({ familyId, sweep, sweptAt: now })))
    .onConflictDoUpdate({
      target: [schema.familySweepMarks.familyId, schema.familySweepMarks.sweep],
      set: { sweptAt: now },
    });
  return ids;
}
