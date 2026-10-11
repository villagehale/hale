import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, asc, eq, gte, lte, ne } from 'drizzle-orm';

/**
 * Week-plan and family-event persistence (VIL-217). Every read and write is
 * family-scoped by the caller's familyId (rule #1): no query crosses families.
 *
 * `readWeekPlan` reads a stored plan; `listFamilyEventsInWindow` is the in-window
 * read of external occasions; `createFamilyEvent` is the write path the
 * channel/email seams land on.
 */

/** The family's plan for a week, or null when it hasn't been composed yet. */
export async function readWeekPlan(
  db: Database,
  familyId: string,
  weekStart: string,
): Promise<schema.WeekPlan | null> {
  const rows = await db
    .select()
    .from(schema.weekPlans)
    .where(and(eq(schema.weekPlans.familyId, familyId), eq(schema.weekPlans.weekStart, weekStart)))
    .limit(1);
  return rows[0] ?? null;
}

/** Records an external occasion for a family and returns the new row id. */
export async function createFamilyEvent(
  db: Database,
  args: {
    familyId: string;
    childId: string | null;
    title: string;
    startsAt: Date;
    endsAt: Date | null;
    location: string | null;
    source: 'parent' | 'channel' | 'email' | 'party';
    createdBy: string | null;
  },
): Promise<string> {
  const inserted = await db
    .insert(schema.familyEvents)
    .values({
      familyId: args.familyId,
      childId: args.childId,
      title: args.title,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      location: args.location,
      source: args.source,
      createdBy: args.createdBy,
    })
    .returning({ id: schema.familyEvents.id });
  const row = inserted[0];
  if (!row) {
    throw new Error('createFamilyEvent: family_events insert returned no row');
  }
  return row.id;
}

/**
 * The family's external OCCASIONS whose start instant falls within [startInstant,
 * endInstant], oldest-first — the composer's in-window read. Family-scoped (rule
 * #1): a foreign family's events never appear.
 *
 * Excludes `source='placement'` and soft-deleted rows (VIL-219): a placement is a
 * durable calendar entry Hale ALREADY placed, not a fresh occasion to re-propose —
 * surfacing it would loop it back into next week's plan. The ICS feed renders both
 * placements and occasions; this composer read is deliberately narrower.
 */
export async function listFamilyEventsInWindow(
  db: Database,
  familyId: string,
  startInstant: Date,
  endInstant: Date,
): Promise<schema.FamilyEvent[]> {
  return db
    .select()
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        gte(schema.familyEvents.startsAt, startInstant),
        lte(schema.familyEvents.startsAt, endInstant),
        ne(schema.familyEvents.source, 'placement'),
        householdFamilyEvent(),
      ),
    )
    .orderBy(asc(schema.familyEvents.startsAt));
}
