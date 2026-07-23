import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import type { CorrelationCandidate } from './correlate';

/**
 * Loads this family's KNOWN occasions — B1's family_events calendar (live
 * placements/occasions, deleted_at IS NULL) + B3's week_plans items that carry a
 * sourceRef (the only ones correlate-able back to a row) — as correlation
 * candidates. A day-coarse week_plans item (no time-of-day) is anchored at
 * family-local midnight; correlate.ts's TIME_WINDOW_HOURS already absorbs that
 * imprecision, so no timezone conversion is attempted here.
 *
 * One family's rows only (rule #1) — every read is WHERE family_id = :familyId.
 * A family's week_plans history is small (one row per week), so this loads all
 * of it rather than adding a second date-range query to bound it.
 */
export async function loadCorrelationCandidates(
  database: Database,
  familyId: string,
): Promise<CorrelationCandidate[]> {
  const events = await database
    .select({
      id: schema.familyEvents.id,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
    })
    .from(schema.familyEvents)
    .where(and(eq(schema.familyEvents.familyId, familyId), isNull(schema.familyEvents.deletedAt)));

  const eventCandidates: CorrelationCandidate[] = events.map((row) => ({
    ref: { table: 'family_events', id: row.id },
    title: row.title,
    startsAt: row.startsAt.toISOString(),
  }));

  const plans = await database
    .select({ items: schema.weekPlans.items })
    .from(schema.weekPlans)
    .where(eq(schema.weekPlans.familyId, familyId));

  const planCandidates: CorrelationCandidate[] = [];
  for (const plan of plans) {
    for (const item of plan.items) {
      if (!item.startsAt || !item.sourceRef) continue;
      planCandidates.push({
        ref: { table: 'week_plans_item', id: item.sourceRef.id },
        title: item.title,
        startsAt: `${item.startsAt}T00:00:00Z`,
      });
    }
  }

  return [...eventCandidates, ...planCandidates];
}
