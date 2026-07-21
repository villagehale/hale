import { type Database, schema } from '@hale/db';
import { and, asc, eq, gte, isNull, lte, ne } from 'drizzle-orm';

/**
 * Persistence for the weekly-plan composer (VIL-217 — "the Sunday brain"). Every
 * read and write is family-scoped by the caller's familyId (rule #1): no query
 * crosses families, and the composer never reads a plan or event it wasn't handed
 * the family for.
 *
 * The cron composes one plan per (family_id, week_start): `hasWeekPlan` is the
 * idempotent-SPEND pre-check it runs BEFORE the LLM step, and `upsertWeekPlan`
 * writes through the unique (family_id, week_start) index so a recompose updates
 * the same row rather than duplicating it. `listFamilyEventsInWindow` is the
 * composer's in-window read of external occasions; `createFamilyEvent` is the write
 * path the channel/email seams land on later.
 */

/**
 * Upserts the family's plan for one week, idempotent per (family_id, week_start):
 * a recompose lands on the same row (the unique index is the conflict target)
 * rather than creating a duplicate. `status` defaults to 'composed' — B2 advances
 * the lifecycle from there. Returns the row id (insert OR conflict-update) so the
 * caller's audit write doesn't need a redundant read-back round-trip (rule #6).
 */
export async function upsertWeekPlan(
  db: Database,
  args: {
    familyId: string;
    weekStart: string;
    summary: string | null;
    items: schema.WeekPlanItem[];
    status?: string;
  },
): Promise<{ id: string }> {
  const status = args.status ?? 'composed';
  const composedAt = new Date();
  const upserted = await db
    .insert(schema.weekPlans)
    .values({
      familyId: args.familyId,
      weekStart: args.weekStart,
      summary: args.summary,
      items: args.items,
      status,
      composedAt,
    })
    .onConflictDoUpdate({
      target: [schema.weekPlans.familyId, schema.weekPlans.weekStart],
      set: { summary: args.summary, items: args.items, status, composedAt },
    })
    .returning({ id: schema.weekPlans.id });
  const row = upserted[0];
  if (!row) {
    throw new Error('upsertWeekPlan: week_plans upsert returned no row');
  }
  return { id: row.id };
}

/**
 * Whether this family's week already has a composed plan — the cron's pre-check
 * before spending the LLM summary step, so a re-run over the same week is a no-op.
 */
export async function hasWeekPlan(
  db: Database,
  familyId: string,
  weekStart: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.weekPlans.id })
    .from(schema.weekPlans)
    .where(and(eq(schema.weekPlans.familyId, familyId), eq(schema.weekPlans.weekStart, weekStart)))
    .limit(1);
  return rows.length > 0;
}

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
    source: 'parent' | 'channel' | 'email';
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
        isNull(schema.familyEvents.deletedAt),
      ),
    )
    .orderBy(asc(schema.familyEvents.startsAt));
}
