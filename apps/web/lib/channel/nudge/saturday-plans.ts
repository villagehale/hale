import { type Database, householdFamilyEvent, schema } from '@hale/db';
import { and, eq, gte, inArray, lt, ne } from 'drizzle-orm';
import { upcomingWeekend } from '~/lib/channel/intake/radar-decide';
import { dayKeyOf, formatTime } from '~/lib/format/datetime';
import { type DayCommitment, isRealCommitment } from './saturday-window';

/**
 * What this household already has on the coming Saturday, or the word that says
 * the leg must not run.
 *
 * `'unread'` is a named absence (rule #11): the empty-Saturday leg does not run
 * and emits no skip, so a caller that has not loaded plans cannot be mistaken for
 * a household whose Saturday is open. Production always loads the real plans.
 *
 * `commitments` is the timed read. When it is present, a morning block does not
 * mark the afternoon busy. `householdBusy` and `busyChildIds` stay for callers
 * that have not loaded times: any family-wide row, or any row at all for a child.
 */
export type SaturdayPlans =
  | 'unread'
  | {
      /** A family-wide all-day commitment, or — when `commitments` is absent — any family-wide row. */
      householdBusy: boolean;
      /** Child-attributed rows. A teen's row does not mark a sibling busy. */
      busyChildIds: ReadonlySet<string>;
      commitments?: readonly DayCommitment[];
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

const ALL_DAY_MS = 20 * 3_600_000;

function minutesOf(date: Date, timeZone: string): number {
  const [hour, minute] = formatTime(date, timeZone).split(':');
  return Number(hour) * 60 + Number(minute);
}

function transparencyOf(value: string | null): DayCommitment['transparency'] {
  if (value === 'opaque' || value === 'transparent') return value;
  return null;
}

function statusOf(value: string | null): DayCommitment['status'] {
  if (value === 'confirmed' || value === 'tentative' || value === 'cancelled' || value === 'free') {
    return value;
  }
  return 'confirmed';
}

function timedCommitment(input: {
  childId: string | null;
  startsAt: Date;
  endsAt: Date | null;
  allDay: boolean;
  transparency: string | null;
  status: string | null;
  timeZone: string;
}): DayCommitment {
  const long =
    input.endsAt !== null && input.endsAt.getTime() - input.startsAt.getTime() >= ALL_DAY_MS;
  return {
    childId: input.childId,
    startMinute: minutesOf(input.startsAt, input.timeZone),
    endMinute: input.endsAt === null ? null : minutesOf(input.endsAt, input.timeZone),
    allDay: input.allDay || long,
    transparency: transparencyOf(input.transparency),
    status: statusOf(input.status),
  };
}

/** Coarse flags derived from the timed read, so an all-day household entry still blocks. */
export function saturdayPlansFromCommitments(
  commitments: readonly DayCommitment[],
): Exclude<SaturdayPlans, 'unread'> {
  const busyChildIds = new Set<string>();
  let householdBusy = false;
  for (const commitment of commitments) {
    if (!isRealCommitment(commitment)) continue;
    if (commitment.childId) busyChildIds.add(commitment.childId);
    if (commitment.childId === null && commitment.allDay) householdBusy = true;
  }
  return { householdBusy, busyChildIds, commitments };
}

/**
 * Live family_events (every source, including placements, not deleted) plus
 * non-cancelled Google and Apple snapshots. `listFamilyEventsInWindow` excludes
 * placements, which is why this query does not use it.
 *
 * Named door (teen-access-outbound.test.ts). The select is child id and times
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
  if (!saturday) return { householdBusy: false, busyChildIds: new Set(), commitments: [] };

  const noon = new Date(`${saturday.date}T12:00:00.000Z`);
  const from = new Date(noon.getTime() - 36 * 3_600_000);
  const until = new Date(noon.getTime() + 36 * 3_600_000);

  const events = await database
    .select({
      childId: schema.familyEvents.childId,
      startsAt: schema.familyEvents.startsAt,
      endsAt: schema.familyEvents.endsAt,
      transparency: schema.familyEvents.transparency,
    })
    .from(schema.familyEvents)
    .where(
      and(
        eq(schema.familyEvents.familyId, familyId),
        householdFamilyEvent(),
        gte(schema.familyEvents.startsAt, from),
        lt(schema.familyEvents.startsAt, until),
      ),
    );

  const snapshots = await database
    .select({
      startAt: schema.calendarEventSnapshots.startAt,
      endAt: schema.calendarEventSnapshots.endAt,
      allDay: schema.calendarEventSnapshots.allDay,
      status: schema.calendarEventSnapshots.status,
      transparency: schema.calendarEventSnapshots.transparency,
    })
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

  const commitments: DayCommitment[] = [];
  for (const event of events) {
    if (dayKeyOf(event.startsAt, timeZone) !== saturday.date) continue;
    commitments.push(
      timedCommitment({
        childId: event.childId,
        startsAt: event.startsAt,
        endsAt: event.endsAt,
        allDay: false,
        transparency: event.transparency,
        status: 'confirmed',
        timeZone,
      }),
    );
  }
  for (const snapshot of snapshots) {
    if (snapshot.startAt === null) continue;
    if (dayKeyOf(snapshot.startAt, timeZone) !== saturday.date) continue;
    commitments.push(
      timedCommitment({
        childId: null,
        startsAt: snapshot.startAt,
        endsAt: snapshot.endAt,
        allDay: snapshot.allDay,
        transparency: snapshot.transparency,
        status: snapshot.status,
        timeZone,
      }),
    );
  }
  return saturdayPlansFromCommitments(commitments);
}
