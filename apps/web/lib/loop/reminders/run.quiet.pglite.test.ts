import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  type ChannelSendJob,
  type ReminderRunDeps,
  defaultReminderRunDeps,
  runReminderCron,
} from './run';

/**
 * VIL-562 · a reminder meets the proactive quiet floor through the SHIPPED deps: the
 * prefs read and the phone read are the production ones, and the parent has no
 * `loop_prefs` row, so the default branch is the one exercised. Only the writer (a model
 * call) and the queue hop are stood in. Denver in November is MST (UTC-7). Every title is
 * invented.
 */

let db: TestDb;
let familyId: string;
let parentUserId: string;
let enqueued: ChannelSendJob[];

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv('LOOP_SEND_ENABLED', 'true');
  vi.stubEnv('PROACTIVE_CADENCE', 'off');
  vi.spyOn(console, 'info').mockImplementation(() => {});
  enqueued = [];
  ({ familyId, parentUserId } = await seedFamily(db.database));
  await db.database
    .update(schema.users)
    .set({ timezone: 'America/Denver' })
    .where(eq(schema.users.id, parentUserId));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function deps(): ReminderRunDeps {
  return {
    ...defaultReminderRunDeps(),
    scopeFamilies: (rows) => rows.filter((row) => row.familyId === familyId),
    client: {} as ReminderRunDeps['client'],
    composeText: async () => ({
      status: 'written',
      draft: { texts: ['test double: model-written reminder'], bold: null },
    }),
    capture: (async () => 'sent') as unknown as ReminderRunDeps['capture'],
    enqueue: async (job) => {
      enqueued.push(job);
    },
  };
}

async function seedEvent(startsAt: string): Promise<string> {
  const [row] = await db.database
    .insert(schema.familyEvents)
    .values({ familyId, title: 'Toddler gym', startsAt: new Date(startsAt), source: 'placement' })
    .returning({ id: schema.familyEvents.id });
  if (!row) throw new Error('event seed returned no row');
  return row.id;
}

async function reminder(offset: '-P1D' | '-PT1H') {
  const [row] = await db.database
    .select({
      status: schema.eventReminders.status,
      suppressReason: schema.eventReminders.suppressReason,
    })
    .from(schema.eventReminders)
    .where(
      and(eq(schema.eventReminders.familyId, familyId), eq(schema.eventReminders.offset, offset)),
    );
  return row;
}

function audits() {
  return db.database.select().from(schema.auditLog).where(eq(schema.auditLog.familyId, familyId));
}

describe('runReminderCron with the shipped deps - the quiet floor (VIL-562)', () => {
  it('holds a T-1h due at 07:40 for an 08:30 event, then sends it at the 08:12 tick', async () => {
    await seedEvent('2026-11-11T15:30:00Z'); // 08:30 MST
    // 18:12 MST the evening before: the evening-before reminder goes out as usual.
    await runReminderCron(db.database, deps(), new Date('2026-11-11T01:12:00Z'));
    expect(enqueued.map((job) => job.dedupeKey)).toEqual([
      expect.stringMatching(/^reminder:-P1D:/),
    ]);

    const held = await runReminderCron(db.database, deps(), new Date('2026-11-11T14:40:00Z'));
    expect(held).toMatchObject({ fired: 0, suppressed: 0, heldQuietHours: 1 });
    expect(enqueued).toHaveLength(1);
    expect(await reminder('-PT1H')).toEqual({ status: 'scheduled', suppressReason: null });
    expect(await audits()).toEqual([]);

    const opened = await runReminderCron(db.database, deps(), new Date('2026-11-11T15:12:00Z'));
    expect(opened).toMatchObject({ fired: 1, firedLate: 0, heldQuietHours: 0 });
    expect(enqueued.map((job) => job.dedupeKey)).toEqual([
      expect.stringMatching(/^reminder:-P1D:/),
      expect.stringMatching(/^reminder:-PT1H:/),
    ]);
    expect(await reminder('-PT1H')).toEqual({ status: 'sent', suppressReason: null });
  });

  it('drops a T-1h due at 21:12 for a 22:00 event, with one audit row, and never revisits it', async () => {
    await seedEvent('2026-11-12T05:00:00Z'); // 22:00 MST on the 11th
    await runReminderCron(db.database, deps(), new Date('2026-11-11T01:12:00Z')); // 18:12 MST the day before
    expect(enqueued).toHaveLength(1);

    const night = await runReminderCron(db.database, deps(), new Date('2026-11-12T04:12:00Z'));
    expect(night).toMatchObject({ fired: 0, suppressed: 1, heldQuietHours: 0 });
    expect(enqueued).toHaveLength(1);
    expect(await reminder('-PT1H')).toEqual({
      status: 'suppressed',
      suppressReason: 'quiet_hours',
    });
    const once = await audits();
    expect(once).toHaveLength(1);
    expect(once[0]).toMatchObject({
      actor: 'system',
      actionTaken: 'reminder_suppressed',
      targetTable: 'event_reminders',
      after: { reason: 'quiet_hours', offset: '-PT1H' },
    });

    await runReminderCron(db.database, deps(), new Date('2026-11-12T15:12:00Z')); // 08:12 MST
    expect(enqueued).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });
});
