import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { reconcileCalendarMirrors } from './calendar-mirror';

/**
 * A connected calendar becomes parent-sourced family_events the reminder cron
 * already reads. The send stays on the outbound gate; this writer never texts.
 */

let db: TestDb;
const NOW = new Date('2026-10-03T16:00:00.000Z');
const SWIM_START = new Date('2026-10-04T15:00:00.000Z');
const TZ = 'America/Toronto';

let family: { familyId: string; parentUserId: string };
let integrationId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  family = await seedFamily(db.database);
  integrationId = await seedIntegration(db.database, family.familyId, family.parentUserId, 'gcal');
});

function swim(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ev-swim',
    status: 'confirmed',
    summary: 'Swim',
    start: { dateTime: SWIM_START.toISOString() },
    end: { dateTime: '2026-10-04T16:00:00.000Z' },
    location: 'The pool',
    ...overrides,
  };
}

function reconcile(
  items: readonly Record<string, unknown>[],
  trustWindow = true,
  id = integrationId,
  userId = family.parentUserId,
) {
  return reconcileCalendarMirrors(db.database, {
    familyId: family.familyId,
    userId,
    integrationId: id,
    items,
    timeZone: TZ,
    now: NOW,
    trustWindow,
  });
}

function rows() {
  return db.database
    .select()
    .from(schema.familyEvents)
    .where(eq(schema.familyEvents.familyId, family.familyId));
}

function audits() {
  return db.database
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.familyId, family.familyId));
}

describe('reconcileCalendarMirrors', () => {
  it('mirrors an upcoming swim as a parent event and audits it without the title', async () => {
    const counts = await reconcile([swim()]);

    expect(counts).toMatchObject({ mirrored: 1, held: false });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      source: 'parent',
      title: 'Swim',
      createdBy: family.parentUserId,
      googleEventId: 'ev-swim',
      integrationId,
      childId: null,
      location: 'The pool',
      deletedAt: null,
    });
    expect(stored[0]?.startsAt.toISOString()).toBe(SWIM_START.toISOString());

    const audit = await audits();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor: 'system',
      actionTaken: 'calendar_mirror_added',
      targetTable: 'family_events',
      after: { source: 'parent' },
    });
    expect(JSON.stringify(audit[0]?.after)).not.toContain('Swim');
    expect(JSON.stringify(audit[0]?.after)).not.toContain('pool');

    const messages = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, family.familyId));
    expect(messages).toEqual([]);
  });

  it('does not mirror a decline, a past event, an out-of-office block, or an all-day busy block', async () => {
    await reconcile([
      swim({
        id: 'ev-no',
        attendees: [{ self: true, responseStatus: 'declined' }],
      }),
      swim({ id: 'ev-past', start: { dateTime: '2026-10-01T15:00:00.000Z' } }),
      swim({ id: 'ev-ooo', eventType: 'outOfOffice' }),
      swim({
        id: 'ev-busy',
        summary: 'Busy',
        start: { date: '2026-10-05' },
        end: { date: '2026-10-06' },
      }),
    ]);

    expect(await rows()).toEqual([]);
    expect(await audits()).toEqual([]);
  });

  it('does not add a second row when a parent YES already covers the occasion', async () => {
    await db.database.insert(schema.familyEvents).values({
      familyId: family.familyId,
      title: 'Swim',
      startsAt: SWIM_START,
      source: 'parent',
      createdBy: family.parentUserId,
    });

    const counts = await reconcile([swim()]);

    expect(counts.alreadyKnown).toBe(1);
    expect(counts.mirrored).toBe(0);
    const stored = await rows();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.googleEventId).toBeNull();
    const messages = await db.database
      .select()
      .from(schema.channelMessages)
      .where(eq(schema.channelMessages.familyId, family.familyId));
    expect(messages).toEqual([]);
  });

  it('moves the mirror when the event moves, and drops it when a complete window no longer lists it', async () => {
    await reconcile([swim()]);
    const movedTo = new Date('2026-10-05T15:00:00.000Z');
    const moved = await reconcile([
      swim({
        start: { dateTime: movedTo.toISOString() },
        end: { dateTime: '2026-10-05T16:00:00.000Z' },
      }),
    ]);
    expect(moved.updated).toBe(1);
    const afterMove = await rows();
    expect(afterMove[0]?.startsAt.toISOString()).toBe(movedTo.toISOString());
    expect(afterMove[0]?.deletedAt).toBeNull();
    const movedAudit = (await audits()).map((row) => row.actionTaken);
    expect(movedAudit).toContain('calendar_mirror_moved');

    await reconcile([]);
    const afterGone = await rows();
    expect(afterGone[0]?.deletedAt).not.toBeNull();
    expect((await audits()).map((row) => row.actionTaken)).toContain('calendar_mirror_removed');
  });

  it('does not delete a mirror the truncated window did not happen to include', async () => {
    await reconcile([swim()]);
    const held = await reconcile(
      [swim({ id: 'ev-other', summary: 'Piano', start: { dateTime: '2026-10-06T15:00:00.000Z' } })],
      false,
    );

    expect(held.held).toBe(false);
    expect(held.mirrored).toBe(1);
    const stored = await rows();
    const swimRow = stored.find((row) => row.googleEventId === 'ev-swim');
    const piano = stored.find((row) => row.googleEventId === 'ev-other');
    expect(swimRow?.deletedAt).toBeNull();
    expect(piano?.deletedAt).toBeNull();
    expect(piano?.title).toBe('Piano');
  });

  it('gives each connecting parent their own mirror of the same title', async () => {
    const [coparent] = await db.database
      .insert(schema.users)
      .values({ email: `${family.familyId}-co@example.test`, name: 'Co Parent' })
      .returning({ id: schema.users.id });
    if (!coparent) throw new Error('co-parent insert returned no row');
    const other = await seedIntegration(db.database, family.familyId, coparent.id, 'gcal');
    await reconcile([swim()]);
    await reconcile([swim()], true, other, coparent.id);

    const stored = await rows();
    const live = stored.filter((row) => row.deletedAt === null);
    expect(live).toHaveLength(2);
    expect(live.map((row) => row.googleEventId)).toEqual(['ev-swim', 'ev-swim']);
    expect(new Set(live.map((row) => row.createdBy))).toEqual(
      new Set([family.parentUserId, coparent.id]),
    );
  });
});
