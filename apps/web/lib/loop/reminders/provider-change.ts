import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { type SourceChange, changeColumns, changeFromSource } from './change';

/**
 * VIL-474 · apply a PROVIDER's move to a Hale event and record what changed.
 *
 * The only writer of the source_changed_* columns. Callers are provider sources: a
 * provider email (a reschedule the sentinel matched to a family_events row) and a
 * registration receipt refreshing a booking linked to its event. A parent's private
 * calendar is never a source: a Google Calendar mirror row (googleEventId set) is
 * refused here, so a parent editing their own calendar records nothing and no venue
 * from a private calendar is ever stored as "changed from".
 */
export async function applyProviderChange(
  database: Database,
  input: {
    familyId: string;
    eventId: string;
    source: { startsAt: Date | null; location: string | null };
    timeZone: string;
    now: Date;
  },
): Promise<SourceChange | null> {
  const [row] = await database
    .select({
      startsAt: schema.familyEvents.startsAt,
      endsAt: schema.familyEvents.endsAt,
      location: schema.familyEvents.location,
      googleEventId: schema.familyEvents.googleEventId,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.id, input.eventId),
        eq(schema.familyEvents.familyId, input.familyId),
        isNull(schema.familyEvents.deletedAt),
      ),
    )
    .limit(1);
  if (!row || row.googleEventId !== null) return null;
  const change = changeFromSource({
    stored: { startsAt: row.startsAt, location: row.location },
    source: input.source,
    timeZone: input.timeZone,
  });
  if (!change) return null;
  const startsAt = change.field === 'venue' ? row.startsAt : (input.source.startsAt as Date);
  // A moved start carries its end with it, so the duration the provider set survives.
  const endsAt =
    row.endsAt && change.field !== 'venue'
      ? new Date(row.endsAt.getTime() + (startsAt.getTime() - row.startsAt.getTime()))
      : row.endsAt;
  await database
    .update(schema.familyEvents)
    .set({
      ...changeColumns(change, input.now),
      startsAt,
      endsAt,
      location: change.field === 'venue' ? (input.source.location?.trim() ?? null) : row.location,
    })
    .where(
      and(
        eq(schema.familyEvents.id, input.eventId),
        eq(schema.familyEvents.familyId, input.familyId),
      ),
    );
  return change;
}
