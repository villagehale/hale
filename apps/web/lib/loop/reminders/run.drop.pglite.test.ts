import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { defaultReminderRunDeps, runReminderCron } from './run';

/**
 * A due reminder the fire path drops leaves its receipt through the SHIPPED deps: the
 * row says why, and an audit row names the drop (rule #6). Driven through
 * `defaultReminderRunDeps` because a fake of the audit write cannot fail on the real one.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const NOW = new Date('2026-07-25T14:10:00Z');

describe('runReminderCron with the shipped deps — a dropped reminder', () => {
  it('marks a held reminder whose event started ten minutes ago suppressed and audits it', async () => {
    vi.stubEnv('LOOP_SEND_ENABLED', 'true');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { familyId, parentUserId } = await seedFamily(db.database);
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId,
        title: 'Swim class',
        startsAt: new Date('2026-07-25T14:00:00Z'),
        source: 'placement',
      })
      .returning({ id: schema.familyEvents.id });
    const [reminder] = await db.database
      .insert(schema.eventReminders)
      .values({
        familyId,
        eventRef: event?.id as string,
        parentUserId,
        offset: '-PT1H',
        fireAt: new Date('2026-07-25T13:00:00Z'),
        status: 'scheduled',
      })
      .returning({ id: schema.eventReminders.id });

    const result = await runReminderCron(db.database, defaultReminderRunDeps(), NOW);

    expect(result).toMatchObject({ fired: 0, suppressed: 1 });
    const [row] = await db.database
      .select({
        status: schema.eventReminders.status,
        suppressReason: schema.eventReminders.suppressReason,
      })
      .from(schema.eventReminders)
      .where(eq(schema.eventReminders.id, reminder?.id as string));
    expect(row).toEqual({ status: 'suppressed', suppressReason: 'started' });
    const audit = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: 'system',
      actionTaken: 'reminder_suppressed',
      targetTable: 'event_reminders',
      targetId: reminder?.id,
      after: { reason: 'started', offset: '-PT1H' },
    });
  });
});
