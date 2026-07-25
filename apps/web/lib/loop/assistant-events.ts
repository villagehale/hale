import { type Database, schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { and, asc, eq, gte, isNull, lte } from 'drizzle-orm';

const PRIVATE_EVENT_TITLE = 'A private calendar item';

export interface AssistantEventRow {
  id: string;
  title: string;
  startsAt: Date;
  endsAt: Date | null;
  location: string | null;
  sensitive: boolean;
  childDob: string | null;
}

export interface TeenSafeAssistantEvent {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
}

/** Deterministic server-side redaction shared by external calendar consumers. */
export function toTeenSafeAssistantEvent(
  row: AssistantEventRow,
  now: Date = new Date(),
): TeenSafeAssistantEvent {
  const teen = row.childDob !== null && deriveStage(row.childDob, now) === 'teenager';
  const privateEvent = teen || row.sensitive;
  return {
    id: row.id,
    title: privateEvent ? PRIVATE_EVENT_TITLE : row.title,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt?.toISOString() ?? null,
    location: privateEvent ? null : row.location,
  };
}

/**
 * Family-explicit live event loader for external assistant/calendar surfaces.
 * Includes both parent occasions and Hale placements, excludes soft-deleted rows,
 * and joins only the DOB needed for the teen age gate.
 */
export async function readTeenSafeFamilyEventsInWindow(
  database: Database,
  familyId: string,
  start: Date,
  end: Date,
  now: Date = new Date(),
): Promise<TeenSafeAssistantEvent[]> {
  const rows = await database
    .select({
      id: schema.familyEvents.id,
      title: schema.familyEvents.title,
      startsAt: schema.familyEvents.startsAt,
      endsAt: schema.familyEvents.endsAt,
      location: schema.familyEvents.location,
      sensitive: schema.familyEvents.sensitive,
      childDob: schema.children.dateOfBirth,
    })
    .from(schema.familyEvents)
    .leftJoin(schema.children, eq(schema.familyEvents.childId, schema.children.id))
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        isNull(schema.familyEvents.deletedAt),
        gte(schema.familyEvents.startsAt, start),
        lte(schema.familyEvents.startsAt, end),
      ),
    )
    .orderBy(asc(schema.familyEvents.startsAt));
  return rows.map((row) => toTeenSafeAssistantEvent(row, now));
}
