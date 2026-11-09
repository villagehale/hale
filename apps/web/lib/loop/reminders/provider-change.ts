import { type Database, schema } from '@hale/db';
import { and, eq, isNull } from 'drizzle-orm';
import { type SourceChange, changeColumns, changeFromSource } from './change';

/**
 * VIL-474 · record a PROVIDER's change to a Hale event. `move: true` also applies it, but
 * no production caller passes it: every caller is reachable from live email.
 *
 * The only writer of the source_changed_* columns. It refuses any event the provider
 * does not own: the event must be linked from one of this family's activity_bookings
 * rows for `providerHost`. A parent-authored event (source 'parent' or any createdBy)
 * and a Google Calendar mirror row (googleEventId set) are refused outright, so a
 * parent's own or private calendar entry is never moved and never recorded.
 *
 * `move: false` (both email paths, the sentinel reschedule and the re-sent receipt, per
 * #955 review and re-review) records the field and old value(s)
 * and leaves the event exactly as it is. Moving from email is a follow-up gated on a
 * model confirming the exact event, ambiguity meaning no move, a confidence floor,
 * provider-owned events only, and an audit_log undo row.
 *
 * `expectStartsAt` (registration path): act only when the event is still at that
 * instant, i.e. it is the booking's first session, so a later session in a series is
 * never marked changed.
 */
export async function applyProviderChange(
  database: Database,
  input: {
    familyId: string;
    eventId: string;
    providerHost: string;
    source: { startsAt: Date | null; location: string | null };
    timeZone: string;
    now: Date;
    move: boolean;
    expectStartsAt?: Date;
  },
): Promise<SourceChange | null> {
  const [row] = await database
    .select({
      startsAt: schema.familyEvents.startsAt,
      endsAt: schema.familyEvents.endsAt,
      location: schema.familyEvents.location,
      googleEventId: schema.familyEvents.googleEventId,
      source: schema.familyEvents.source,
      createdBy: schema.familyEvents.createdBy,
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
  if (row.source === 'parent' || row.createdBy !== null) return null;
  const [owned] = await database
    .select({ id: schema.activityBookings.id })
    .from(schema.activityBookings)
    .where(
      and(
        eq(schema.activityBookings.familyId, input.familyId),
        eq(schema.activityBookings.eventId, input.eventId),
        eq(schema.activityBookings.providerHost, input.providerHost.trim().toLowerCase()),
      ),
    )
    .limit(1);
  if (!owned) return null;
  if (input.expectStartsAt && row.startsAt.getTime() !== input.expectStartsAt.getTime()) {
    return null;
  }
  const change = changeFromSource({
    stored: { startsAt: row.startsAt, location: row.location },
    source: input.source,
    timeZone: input.timeZone,
  });
  if (!change) return null;
  if (!input.move) {
    await database
      .update(schema.familyEvents)
      .set(changeColumns(change, input.now))
      .where(
        and(
          eq(schema.familyEvents.id, input.eventId),
          eq(schema.familyEvents.familyId, input.familyId),
        ),
      );
    return change;
  }
  const startMoved = change.field !== 'venue';
  const venueMoved = change.previousLocation !== undefined;
  const startsAt = startMoved ? (input.source.startsAt as Date) : row.startsAt;
  // A moved start carries its end with it, so the duration the provider set survives.
  const endsAt =
    row.endsAt && startMoved
      ? new Date(row.endsAt.getTime() + (startsAt.getTime() - row.startsAt.getTime()))
      : row.endsAt;
  await database
    .update(schema.familyEvents)
    .set({
      ...changeColumns(change, input.now),
      startsAt,
      endsAt,
      location: venueMoved ? (input.source.location?.trim() ?? null) : row.location,
    })
    .where(
      and(
        eq(schema.familyEvents.id, input.eventId),
        eq(schema.familyEvents.familyId, input.familyId),
      ),
    );
  return change;
}
