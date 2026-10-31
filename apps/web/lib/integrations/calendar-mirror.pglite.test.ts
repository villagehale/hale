import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { reconcileCalendarMirrors } from './calendar-mirror';
import {
  EVENT_NOTES_FAILED,
  EVENT_NOTES_MAX_FAILED_READS,
  type EventNotesReader,
  notesSourceHash,
} from './event-notes';

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
  readNotes?: EventNotesReader,
) {
  return reconcileCalendarMirrors(db.database, {
    familyId: family.familyId,
    userId,
    integrationId: id,
    items,
    timeZone: TZ,
    now: NOW,
    trustWindow,
    ...(readNotes ? { readNotes } : {}),
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
  it('stores only the facts the reader returns, and reads a description once (VIL-468)', async () => {
    const readNotes = vi.fn(async ({ description }: { title: string; description: string }) =>
      description.includes('back lot')
        ? {
            parking: 'the back lot off Elm',
            bring: 'goggles',
            sourceHash: notesSourceHash('Swim', description),
          }
        : { sourceHash: notesSourceHash('Swim', description) },
    );
    const desc = 'Private coach note. Park in the back lot off Elm, and the kids need goggles.';
    await reconcile(
      [swim({ description: desc })],
      true,
      integrationId,
      family.parentUserId,
      readNotes,
    );
    let stored = await rows();
    expect(stored[0]?.notes).toMatchObject({ parking: 'the back lot off Elm', bring: 'goggles' });
    expect(JSON.stringify(stored[0])).not.toContain('Private coach note');

    expect(
      await reconcile(
        [swim({ description: desc })],
        true,
        integrationId,
        family.parentUserId,
        readNotes,
      ),
    ).toMatchObject({ updated: 0 });
    expect(readNotes).toHaveBeenCalledTimes(1);

    const counts = await reconcile(
      [swim({ description: 'See you there!' })],
      true,
      integrationId,
      family.parentUserId,
      readNotes,
    );
    expect(counts).toMatchObject({ updated: 1 });
    stored = await rows();
    expect(stored[0]?.notes).toEqual({ sourceHash: notesSourceHash('Swim', 'See you there!') });

    await reconcile([swim()], true, integrationId, family.parentUserId, readNotes);
    stored = await rows();
    expect(stored[0]?.notes).toBeNull();
    expect(readNotes).toHaveBeenCalledTimes(2);
  });

  it('a no-attempt read (no key) stores nothing and counts nothing (VIL-468)', async () => {
    await reconcile(
      [swim({ description: 'Park in the back lot' })],
      true,
      integrationId,
      family.parentUserId,
      async () => null,
    );
    expect((await rows())[0]?.notes).toBeNull();
  });

  it('a transient failure is retried and a success resets the count (VIL-468)', async () => {
    const desc = 'Park in the back lot';
    const h = notesSourceHash('Swim', desc);
    const readNotes = vi
      .fn<EventNotesReader>()
      .mockResolvedValueOnce(EVENT_NOTES_FAILED)
      .mockResolvedValueOnce({ parking: 'the back lot', sourceHash: h });
    const run = () =>
      reconcile([swim({ description: desc })], true, integrationId, family.parentUserId, readNotes);
    await run();
    expect((await rows())[0]?.notes).toEqual({ sourceHash: h, failedReads: 1 });
    await run();
    expect((await rows())[0]?.notes).toEqual({ parking: 'the back lot', sourceHash: h });
    await run();
    expect(readNotes).toHaveBeenCalledTimes(2);
  });

  it('stops after 3 failures of one description, and a new description resets (VIL-468)', async () => {
    const readNotes = vi.fn<EventNotesReader>(async () => EVENT_NOTES_FAILED);
    const run = (description: string) =>
      reconcile([swim({ description })], true, integrationId, family.parentUserId, readNotes);
    for (let i = 0; i < 5; i += 1) await run('Park in the back lot');
    expect(readNotes).toHaveBeenCalledTimes(EVENT_NOTES_MAX_FAILED_READS);
    let notes = (await rows())[0]?.notes;
    expect(notes).toEqual({
      sourceHash: notesSourceHash('Swim', 'Park in the back lot'),
      failedReads: 3,
    });
    expect(notes).not.toHaveProperty('parking');

    await run('Park on Elm instead');
    expect(readNotes).toHaveBeenCalledTimes(4);
    notes = (await rows())[0]?.notes;
    expect(notes).toEqual({
      sourceHash: notesSourceHash('Swim', 'Park on Elm instead'),
      failedReads: 1,
    });
  });

  it('a renamed event with the same description is re-read, not given stale facts (Devin #930)', async () => {
    const desc = 'Park in the back lot';
    const readNotes = vi.fn<EventNotesReader>(async ({ title, description }) =>
      title === 'Swim'
        ? { parking: 'the back lot', sourceHash: notesSourceHash(title, description) }
        : { sourceHash: notesSourceHash(title, description) },
    );
    await reconcile(
      [swim({ description: desc })],
      true,
      integrationId,
      family.parentUserId,
      readNotes,
    );
    await reconcile(
      [swim({ summary: 'Skate', description: desc })],
      true,
      integrationId,
      family.parentUserId,
      readNotes,
    );
    expect(readNotes).toHaveBeenCalledTimes(2);
    expect((await rows())[0]?.notes).toEqual({ sourceHash: notesSourceHash('Skate', desc) });
  });

  it('a renamed event whose re-read is deferred keeps no stale facts (Devin #930)', async () => {
    const desc = 'Park in the back lot';
    await reconcile(
      [swim({ description: desc })],
      true,
      integrationId,
      family.parentUserId,
      async () => ({
        parking: 'the back lot',
        sourceHash: notesSourceHash('Swim', desc),
      }),
    );
    await reconcile(
      [swim({ summary: 'Skate', description: desc })],
      true,
      integrationId,
      family.parentUserId,
      async () => null,
    );
    expect((await rows())[0]?.notes).toBeNull();
  });

  it('a logistics-only change writes an audit row without the facts (Devin #930)', async () => {
    const reader =
      (parking: string): EventNotesReader =>
      async ({ title, description }) => ({
        parking,
        sourceHash: notesSourceHash(title, description),
      });
    await reconcile(
      [swim({ description: 'Park A' })],
      true,
      integrationId,
      family.parentUserId,
      reader('lot A'),
    );
    await reconcile(
      [swim({ description: 'Park B' })],
      true,
      integrationId,
      family.parentUserId,
      reader('lot B'),
    );
    const rowsAudit = (await audits()).filter(
      (a) => a.actionTaken === 'calendar_mirror_notes_updated',
    );
    expect(rowsAudit).toHaveLength(1);
    expect(rowsAudit[0]?.after).toEqual({ source: 'parent' });
    expect(JSON.stringify(rowsAudit[0])).not.toContain('lot B');
  });

  it('a failed-read count bump alone writes no audit row', async () => {
    await reconcile(
      [swim({ description: 'Park A' })],
      true,
      integrationId,
      family.parentUserId,
      async () => EVENT_NOTES_FAILED,
    );
    await reconcile(
      [swim({ description: 'Park A' })],
      true,
      integrationId,
      family.parentUserId,
      async () => EVENT_NOTES_FAILED,
    );
    expect(
      (await audits()).filter((a) => a.actionTaken === 'calendar_mirror_notes_updated'),
    ).toHaveLength(0);
  });

  it('a removed mirror drops its logistics notes (Devin #930)', async () => {
    await reconcile(
      [swim({ description: 'Park A' })],
      true,
      integrationId,
      family.parentUserId,
      async ({ title, description }) => ({
        parking: 'lot A',
        sourceHash: notesSourceHash(title, description),
      }),
    );
    await reconcile([]);
    const [row] = await rows();
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.notes).toBeNull();
  });

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

  it('VIL-474: a parent moving their own calendar event records no change at all', async () => {
    await reconcile([swim()]);
    const later = new Date('2026-10-04T16:30:00.000Z');
    await reconcile([
      swim({
        start: { dateTime: later.toISOString() },
        end: { dateTime: '2026-10-04T17:30:00.000Z' },
        location: 'Main St pool',
      }),
    ]);
    const row = (await rows())[0];
    expect(row?.startsAt.toISOString()).toBe(later.toISOString());
    expect(row?.sourceChangedField).toBeNull();
    expect(row?.sourceChangedFromStartsAt).toBeNull();
    expect(row?.sourceChangedFromLocation).toBeNull();
    expect(row?.sourceChangedAt).toBeNull();
  });

  it('VIL-474: a removed mirror clears all four source_changed_* columns', async () => {
    await reconcile([swim()]);
    const [seeded] = await rows();
    if (!seeded) throw new Error('no mirror');
    // A row written before mirrors stopped recording changes still carries them.
    await db.database
      .update(schema.familyEvents)
      .set({
        sourceChangedField: 'venue',
        sourceChangedFromStartsAt: SWIM_START,
        sourceChangedFromLocation: 'The pool',
        sourceChangedAt: NOW,
      })
      .where(eq(schema.familyEvents.id, seeded.id));
    await reconcile([]);
    const row = (await rows())[0];
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.sourceChangedField).toBeNull();
    expect(row?.sourceChangedFromStartsAt).toBeNull();
    expect(row?.sourceChangedFromLocation).toBeNull();
    expect(row?.sourceChangedAt).toBeNull();
  });

  it("a removed mirror keeps none of the parent's words, and a live one is untouched", async () => {
    const piano = swim({
      id: 'ev-piano',
      summary: 'Piano',
      start: { dateTime: '2026-10-06T15:00:00.000Z' },
      end: { dateTime: '2026-10-06T16:00:00.000Z' },
    });
    await reconcile([swim(), piano]);
    await db.database
      .update(schema.familyEvents)
      .set({ dutyOwnerLabel: 'Nana' })
      .where(eq(schema.familyEvents.googleEventId, 'ev-swim'));

    await expect(reconcile([piano])).resolves.toMatchObject({ removed: 1 });

    const stored = await rows();
    expect(stored.find((row) => row.googleEventId === 'ev-swim')).toMatchObject({
      title: '',
      location: null,
      dutyOwnerLabel: null,
      deletedAt: NOW,
    });
    expect(stored.find((row) => row.googleEventId === 'ev-piano')).toMatchObject({
      title: 'Piano',
      location: 'The pool',
      deletedAt: null,
    });

    // The calendar listing it again brings the words back from Google, not from the row.
    await reconcile([swim(), piano]);
    expect((await rows()).find((row) => row.googleEventId === 'ev-swim')).toMatchObject({
      title: 'Swim',
      location: 'The pool',
      deletedAt: null,
    });
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

  it('names an empty untrusted window as held for untrusted_window and deletes nothing', async () => {
    await reconcile([swim()]);

    await expect(reconcile([], false)).resolves.toEqual({
      mirrored: 0,
      updated: 0,
      removed: 0,
      alreadyKnown: 0,
      skipped: 0,
      held: true,
      heldReason: 'untrusted_window',
    });
    const stored = await rows();
    expect(stored.map((row) => [row.googleEventId, row.deletedAt])).toEqual([['ev-swim', null]]);
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
