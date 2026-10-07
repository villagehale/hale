import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultReminderRunDeps } from '~/lib/loop/reminders/run';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { revokeConnection, saveConnection } from './store';

/**
 * Disconnecting a calendar ends its mirrors. The integrations row survives a revoke
 * (status 'revoked'), so the ON DELETE CASCADE on family_events.integration_id never
 * fires; the revoke itself has to retire them, and only the revoked connection's.
 */

const SATURDAY = new Date('2026-10-10T15:00:00.000Z');
const TOKENS = { accessToken: 'ya29.test-access', refreshToken: '1//test-refresh' };

let db: TestDb;
let familyId: string;
let parentUserId: string;
let coParentUserId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  const family = await seedFamily(db.database);
  familyId = family.familyId;
  parentUserId = family.parentUserId;
  const [co] = await db.database
    .insert(schema.users)
    .values({ email: `co-${randomUUID()}@example.test`, name: 'Co Parent' })
    .returning({ id: schema.users.id });
  if (!co) throw new Error('co-parent insert returned no row');
  coParentUserId = co.id;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: coParentUserId, role: 'co_parent' });
});

async function connect(userId: string): Promise<string> {
  await saveConnection(db.database, {
    familyId,
    userId,
    provider: 'gcal',
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    tokens: TOKENS,
  });
  const [row] = await db.database
    .select({ id: schema.integrations.id })
    .from(schema.integrations)
    .where(and(eq(schema.integrations.familyId, familyId), eq(schema.integrations.userId, userId)));
  if (!row) throw new Error('connection was not saved');
  return row.id;
}

async function seedEvent(
  values: Partial<typeof schema.familyEvents.$inferInsert>,
): Promise<string> {
  const [row] = await db.database
    .insert(schema.familyEvents)
    .values({ familyId, title: 'Occasion', startsAt: SATURDAY, source: 'parent', ...values })
    .returning({ id: schema.familyEvents.id });
  if (!row) throw new Error('family_events seed returned no row');
  return row.id;
}

async function deletedAtOf(id: string): Promise<Date | null> {
  const [row] = await db.database
    .select({ deletedAt: schema.familyEvents.deletedAt })
    .from(schema.familyEvents)
    .where(eq(schema.familyEvents.id, id));
  if (!row) throw new Error(`family_events ${id} is gone`);
  return row.deletedAt;
}

async function scheduleReminder(eventRef: string, userId: string): Promise<void> {
  await db.database.insert(schema.eventReminders).values({
    familyId,
    eventRef,
    parentUserId: userId,
    offset: '-PT1H',
    fireAt: new Date(SATURDAY.getTime() - 3_600_000),
    status: 'scheduled',
  });
}

async function reminderStatus(eventRef: string): Promise<string | undefined> {
  const [row] = await db.database
    .select({ status: schema.eventReminders.status })
    .from(schema.eventReminders)
    .where(eq(schema.eventReminders.eventRef, eventRef));
  return row?.status;
}

describe('revokeConnection retires the revoked calendar’s mirrors', () => {
  it("soft-deletes only the disconnecting parent's mirror and leaves the co-parent's mirror and a placement", async () => {
    const parentIntegration = await connect(parentUserId);
    const coParentIntegration = await connect(coParentUserId);
    const parentMirror = await seedEvent({
      title: 'Parent private item',
      createdBy: parentUserId,
      googleEventId: 'google-parent-1',
      integrationId: parentIntegration,
    });
    const coParentMirror = await seedEvent({
      title: 'Co-parent private item',
      createdBy: coParentUserId,
      googleEventId: 'google-co-1',
      integrationId: coParentIntegration,
    });
    const placement = await seedEvent({
      title: 'Swim lesson',
      source: 'placement',
      placedGoogleEventId: 'google-placed-1',
      placedGoogleIntegrationId: parentIntegration,
    });
    await scheduleReminder(parentMirror, parentUserId);
    await scheduleReminder(coParentMirror, coParentUserId);

    const revoked = await revokeConnection(db.database, familyId, parentUserId, 'gcal', 'settings');

    expect(revoked).toBe(1);
    expect(await deletedAtOf(parentMirror)).toBeInstanceOf(Date);
    expect(await deletedAtOf(coParentMirror)).toBeNull();
    expect(await deletedAtOf(placement)).toBeNull();

    const [audit] = await db.database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, familyId),
          eq(schema.auditLog.actionTaken, 'integration_revoked'),
        ),
      );
    expect(audit?.after).toMatchObject({ provider: 'gcal', calendarMirrorsRemoved: 1 });
    expect(JSON.stringify(audit?.after)).not.toContain('private item');

    await defaultReminderRunDeps().cancelDeletedEventReminders(db.database, familyId);
    expect(await reminderStatus(parentMirror)).toBe('cancelled');
    expect(await reminderStatus(coParentMirror)).toBe('scheduled');
  });
});
