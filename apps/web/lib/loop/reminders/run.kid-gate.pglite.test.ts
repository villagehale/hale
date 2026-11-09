import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { type ReminderRunDeps, defaultReminderRunDeps, runReminderCron } from './run';

/**
 * VIL-548. A row mirrored from a parent's own Google Calendar is reminded about only while
 * it links to a `kid` verdict. Driven through the SHIPPED deps, because the gate reads the
 * verdict in the loaders' own join, and a fake of a loader cannot fail on that join. No
 * model: with no client a reminder that passes the gate is dropped as `unwritten`, which is
 * how the positive control shows it got past. Every title is invented.
 */

let db: TestDb;
let familyId: string;
let parentUserId: string;
let integrationId: string;

const NOW = new Date('2026-10-14T20:00:00.000Z');
const TZ = 'America/Denver';

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv('PARENT_CALENDAR_MIRROR_ENABLED', 'true');
  vi.stubEnv('ANTHROPIC_API_KEY', '');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ({ familyId, parentUserId } = await seedFamily(db.database));
  integrationId = await seedIntegration(db.database, familyId, parentUserId, 'gcal');
  await db.database
    .update(schema.users)
    .set({ timezone: TZ })
    .where(eq(schema.users.id, parentUserId));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** The shipped deps, narrowed to this test's family, with no reminder writer. */
function deps(): ReminderRunDeps {
  return {
    ...defaultReminderRunDeps(),
    client: null,
    scopeFamilies: (rows) => rows.filter((row) => row.familyId === familyId),
  };
}

async function seedVerdict(itemKey: string, verdict: 'kid' | 'adult'): Promise<string> {
  const [row] = await db.database
    .insert(schema.kidRelevanceVerdicts)
    .values({
      familyId,
      source: 'google_calendar',
      integrationId,
      itemKey,
      inputHash: 'a-judged-input',
      verdict,
      decidedBy: 'model',
    })
    .returning({ id: schema.kidRelevanceVerdicts.id });
  if (!row) throw new Error('verdict seed returned no row');
  return row.id;
}

async function seedEvent(values: {
  title: string;
  startsAt: Date;
  googleEventId: string | null;
  kidVerdictId?: string;
}): Promise<string> {
  const [row] = await db.database
    .insert(schema.familyEvents)
    .values({
      familyId,
      title: values.title,
      startsAt: values.startsAt,
      source: values.googleEventId ? 'parent' : 'placement',
      createdBy: parentUserId,
      googleEventId: values.googleEventId,
      integrationId: values.googleEventId ? integrationId : null,
      kidVerdictId: values.kidVerdictId ?? null,
    })
    .returning({ id: schema.familyEvents.id });
  if (!row) throw new Error('event seed returned no row');
  return row.id;
}

function reminderRows() {
  return db.database
    .select({
      eventRef: schema.eventReminders.eventRef,
      offset: schema.eventReminders.offset,
      status: schema.eventReminders.status,
      suppressReason: schema.eventReminders.suppressReason,
    })
    .from(schema.eventReminders)
    .where(eq(schema.eventReminders.familyId, familyId));
}

describe('runReminderCron with the shipped deps - the mirror kid gate (VIL-548)', () => {
  it('T6: holds a due reminder on a mirror with no kid verdict or an adult one, and lets a kid-linked one through', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    // Starts in 50 minutes, so each -PT1H reminder came due 10 minutes ago.
    const startsAt = new Date(NOW.getTime() + 50 * 60_000);
    const unlinked = await seedEvent({ title: 'Team offsite', startsAt, googleEventId: 'ev-a' });
    const kid = await seedEvent({
      title: 'Juniper swim lesson',
      startsAt,
      googleEventId: 'ev-b',
      kidVerdictId: await seedVerdict('ev-b', 'kid'),
    });
    const adult = await seedEvent({
      title: 'Quarterly budget review',
      startsAt,
      googleEventId: 'ev-c',
      kidVerdictId: await seedVerdict('ev-c', 'adult'),
    });
    await db.database.insert(schema.eventReminders).values(
      [unlinked, kid, adult].map((eventRef) => ({
        familyId,
        eventRef,
        parentUserId,
        offset: '-PT1H' as const,
        fireAt: new Date(startsAt.getTime() - 60 * 60_000),
        status: 'scheduled' as const,
      })),
    );
    // The kid event's evening-before reminder already went out, so this run fires only the
    // -PT1H rows under test.
    await db.database.insert(schema.eventReminders).values({
      familyId,
      eventRef: kid,
      parentUserId,
      offset: '-P1D',
      fireAt: new Date('2026-10-14T00:00:00.000Z'),
      status: 'sent',
    });

    const result = await runReminderCron(db.database, deps(), NOW);

    // The unlinked and the adult-linked mirror are held: two rows.
    expect(result.heldNoKidVerdict).toBe(2);
    const rows = await reminderRows();
    const byEvent = (ref: string) => rows.filter((row) => row.eventRef === ref);
    expect(byEvent(unlinked)).toEqual([
      { eventRef: unlinked, offset: '-PT1H', status: 'scheduled', suppressReason: null },
    ]);
    expect(byEvent(adult)).toEqual([
      { eventRef: adult, offset: '-PT1H', status: 'scheduled', suppressReason: null },
    ]);
    // Positive control: the kid-linked mirror passed the gate and reached the writer, which
    // has no client here.
    expect(
      byEvent(kid)
        .map((row) => [row.offset, row.status, row.suppressReason])
        .sort(),
    ).toEqual([
      ['-P1D', 'sent', null],
      ['-PT1H', 'suppressed', 'unwritten'],
    ]);
    // Converge: the unlinked and the adult-linked mirror get none of their two offsets.
    expect(result).toMatchObject({ suppressed: 1, fired: 0, notScheduledNoKidVerdict: 4 });
    expect(console.info).toHaveBeenCalledWith(
      { heldNoKidVerdict: 2, notScheduledNoKidVerdict: 4 },
      'reminder: mirror rows without a kid verdict, not sent',
    );
  });

  it('T7: converge schedules nothing for an unlinked mirror, and still schedules a Hale-authored event', async () => {
    const startsAt = new Date(NOW.getTime() + 2 * 86_400_000);
    const mirror = await seedEvent({ title: 'Team offsite', startsAt, googleEventId: 'ev-a' });
    const placement = await seedEvent({
      title: 'Juniper swim lesson',
      startsAt,
      googleEventId: null,
    });

    const result = await runReminderCron(db.database, deps(), NOW);

    expect(result.notScheduledNoKidVerdict).toBe(2);
    const rows = await reminderRows();
    expect(rows.filter((row) => row.eventRef === mirror)).toEqual([]);
    expect(
      rows
        .filter((row) => row.eventRef === placement)
        .map((row) => row.offset)
        .sort(),
    ).toEqual(['-P1D', '-PT1H']);
  });
});
