import { type Database, schema } from '@hale/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { forgetFamilyFact } from './forget';

/**
 * One-off repair for the 2026-10-01 distiller incident.
 *
 * A suggestion list (Tiny Dancers, Parent & Tot Swimming on Oct 3) was stored
 * as a live `children_age_range` fact. This closes that live row for the family
 * whose id starts with {@link FALSE_CHILDREN_AGE_RANGE_FAMILY_PREFIX}, by
 * setting `valid_until` through {@link forgetFamilyFact}. It does not insert a
 * replacement fact.
 *
 * Idempotent: a second run finds no live row, so the first `valid_until` stays
 * put. Not called from any cron, route, or startup path. The operator runs
 * `scripts/supersede-false-children-age-range.ts`.
 */

export const FALSE_CHILDREN_AGE_RANGE_FAMILY_PREFIX = '2c939172';
export const FALSE_CHILDREN_AGE_RANGE_FACT_KEY = 'children_age_range';
export const FALSE_CHILDREN_AGE_RANGE_ACTOR = 'system:supersede-false-children-age-range';

export interface SupersedeFalseChildrenAgeRangeResult {
  matched: number;
  forgotten: number;
  alreadyClosed: number;
  notFound: number;
  refused: number;
}

export async function supersedeFalseChildrenAgeRange(
  database: Database,
  input: { now: Date; familyIdPrefix?: string; actor?: string },
): Promise<SupersedeFalseChildrenAgeRangeResult> {
  const prefix = (input.familyIdPrefix ?? FALSE_CHILDREN_AGE_RANGE_FAMILY_PREFIX).toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(prefix)) {
    throw new Error('supersedeFalseChildrenAgeRange: family id prefix must be 8 hex characters');
  }

  const rows = await database
    .select({
      id: schema.familyMemoryFacts.id,
      familyId: schema.familyMemoryFacts.familyId,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.factKey, FALSE_CHILDREN_AGE_RANGE_FACT_KEY),
        isNull(schema.familyMemoryFacts.validUntil),
        sql`lower(${schema.familyMemoryFacts.familyId}::text) like ${`${prefix}%`}`,
      ),
    );

  const result: SupersedeFalseChildrenAgeRangeResult = {
    matched: rows.length,
    forgotten: 0,
    alreadyClosed: 0,
    notFound: 0,
    refused: 0,
  };
  const actor = input.actor ?? FALSE_CHILDREN_AGE_RANGE_ACTOR;
  for (const row of rows) {
    const outcome = await forgetFamilyFact(database, {
      familyId: row.familyId,
      factId: row.id,
      actor,
      now: input.now,
    });
    result.forgotten += outcome.forgotten;
    result.alreadyClosed += outcome.alreadyClosed;
    result.notFound += outcome.notFound;
    result.refused += outcome.refusedControlPlane + outcome.refusedWriter;
  }
  return result;
}
