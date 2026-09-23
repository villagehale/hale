import { type Database, schema } from '@hale/db';
import { and, eq, gte, inArray, isNull, lt, ne } from 'drizzle-orm';
import { upcomingWeekend } from '~/lib/channel/intake/radar-decide';
import { dayKeyOf } from '~/lib/format/datetime';

/**
 * What this household already has on the coming Saturday, or the word that says
 * the leg must not run.
 *
 * `'unread'` is a named absence (rule #11): the empty-Saturday leg does not run
 * and emits no skip, so a caller that has not loaded plans cannot be mistaken for
 * a household whose Saturday is open. Production always loads the real plans.
 */
export type SaturdayPlans =
  | 'unread'
  | {
      /** A family-wide event, or anything on a connected calendar. Do not claim the day is open. */
      householdBusy: boolean;
      /** Child-attributed family_events. A teen's row does not mark a sibling busy. */
      busyChildIds: ReadonlySet<string>;
    };

export function saturdayPlansFromRows(
  rows: readonly { childId: string | null }[],
): Exclude<SaturdayPlans, 'unread'> {
  const busyChildIds = new Set<string>();
  let householdBusy = false;
  for (const row of rows) {
    if (row.childId) busyChildIds.add(row.childId);
    else householdBusy = true;
  }
  return { householdBusy, busyChildIds };
}

/**
 * Live family_events (every source, including placements, not deleted) plus
 * non-cancelled Google and Apple snapshots. `listFamilyEventsInWindow` excludes
 * placements, which is why this query does not use it.
 *
 * Named door (teen-access-outbound.test.ts). The select is child id and start time
 * only. A title or a location here would put a 13+ child's calendar words on an
 * outbound path that has no viewer.
 *
 * The window is wide in UTC and then filtered to the family-local Saturday, so a
 * zone offset cannot drop an evening session or pull in Friday.
 */
export async function loadSaturdayPlans(
  database: Database,
  familyId: string,
  now: Date,
  timeZone: string,
): Promise<Exclude<SaturdayPlans, 'unread'>> {
  const saturday = upcomingWeekend(now, timeZone).find((slot) => slot.day === 'saturday');
  if (!saturday) return { householdBusy: false, busyChildIds: new Set() };

  const noon = new Date(`${saturday.date}T12:00:00.000Z`);
  const from = new Date(noon.getTime() - 36 * 3_600_000);
  const until = new Date(noon.getTime() + 36 * 3_600_000);

  const events = await database
    .select({
      childId: schema.familyEvents.childId,
      startsAt: schema.familyEvents.startsAt,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        isNull(schema.familyEvents.deletedAt),
        gte(schema.familyEvents.startsAt, from),
        lt(schema.familyEvents.startsAt, until),
      ),
    );

  const snapshots = await database
    .select({ startAt: schema.calendarEventSnapshots.startAt })
    .from(schema.calendarEventSnapshots)
    .innerJoin(
      schema.integrations,
      eq(schema.calendarEventSnapshots.integrationId, schema.integrations.id),
    )
    .where(
      and(
        eq(schema.integrations.familyId, familyId),
        inArray(schema.integrations.provider, ['gcal', 'apple_cal']),
        ne(schema.calendarEventSnapshots.status, 'cancelled'),
        gte(schema.calendarEventSnapshots.startAt, from),
        lt(schema.calendarEventSnapshots.startAt, until),
      ),
    );

  const rows: { childId: string | null }[] = [];
  for (const event of events) {
    if (dayKeyOf(event.startsAt, timeZone) !== saturday.date) continue;
    rows.push({ childId: event.childId });
  }
  for (const snapshot of snapshots) {
    if (snapshot.startAt === null) continue;
    if (dayKeyOf(snapshot.startAt, timeZone) !== saturday.date) continue;
    rows.push({ childId: null });
  }
  return saturdayPlansFromRows(rows);
}
