import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultReminderRunDeps, runReminderCron } from '~/lib/loop/reminders/run';
import { kidForAllClient, scriptedKidClient } from '~/lib/testing/kid-judge-client';
import { type TestDb, createTestDb, seedFamily, seedIntegration } from '~/lib/testing/pglite';
import { type CalendarMirrorKidJudge, reconcileCalendarMirrors } from './calendar-mirror';
import {
  EVENT_NOTES_FAILED,
  EVENT_NOTES_MAX_FAILED_READS,
  type EventNotesReader,
  legacyDescriptionHash,
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
const INPUT_KEY = Buffer.alloc(32, 7).toString('base64');
const NO_DEADLINE = new Date('2099-01-01T00:00:00.000Z');

let family: { familyId: string; parentUserId: string };
let integrationId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  // The kid judge hashes its input with a keyed blind index; the scripted client answers
  // on the non-streaming path.
  process.env.APP_ENCRYPTION_KEY = INPUT_KEY;
  process.env.HALE_LLM_NO_STREAM = '1';
  family = await seedFamily(db.database);
  integrationId = await seedIntegration(db.database, family.familyId, family.parentUserId, 'gcal');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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
    // Not about the kid gate: every event is the kids', as every mirror was before it.
    kidJudge: { mode: 'model', client: kidForAllClient(), deadline: NO_DEADLINE },
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

  async function seedLegacyNotes(desc: string) {
    await reconcile([swim({ description: desc })]);
    await db.database
      .update(schema.familyEvents)
      .set({ notes: { parking: 'the back lot', sourceHash: legacyDescriptionHash(desc) } })
      .where(eq(schema.familyEvents.familyId, family.familyId));
  }

  it('first sync after the hash format change keeps notes of an unchanged event (Devin #930)', async () => {
    const desc = 'Park in the back lot';
    await seedLegacyNotes(desc);
    const readNotes = vi.fn<EventNotesReader>(async () => null);
    const before = (await audits()).length;
    await reconcile(
      [swim({ description: desc })],
      true,
      integrationId,
      family.parentUserId,
      readNotes,
    );
    expect(readNotes).not.toHaveBeenCalled();
    expect((await rows())[0]?.notes).toEqual({
      parking: 'the back lot',
      sourceHash: notesSourceHash('Swim', desc),
    });
    // A rehash is bookkeeping, not a logistics change.
    expect((await audits()).length).toBe(before);
  });

  it('a legacy-hashed event that was renamed is still re-read (Devin #930)', async () => {
    const desc = 'Park in the back lot';
    await seedLegacyNotes(desc);
    const readNotes = vi.fn<EventNotesReader>(async ({ title, description }) => ({
      sourceHash: notesSourceHash(title, description),
    }));
    await reconcile(
      [swim({ summary: 'Skate', description: desc })],
      true,
      integrationId,
      family.parentUserId,
      readNotes,
    );
    expect(readNotes).toHaveBeenCalledTimes(1);
    expect((await rows())[0]?.notes).toEqual({ sourceHash: notesSourceHash('Skate', desc) });
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
      notKid: 0,
      unjudged: 0,
      unjudgedNoJudge: 0,
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

/**
 * VIL-548. A mirror is written only for an event the kid judge (or the parent) says is
 * about the kids, and the reminder cron schedules nothing for any other. The judge, its
 * verdict table, the mirror and the reminder run are all real; only the model is scripted
 * at the AgentClient port. Every name and title is invented.
 */
describe('reconcileCalendarMirrors - the kid gate (VIL-548)', () => {
  const KID_TZ = 'America/Denver';
  const LESSON_START = new Date('2026-10-05T16:00:00.000Z');
  const LESSON_END = new Date('2026-10-05T17:00:00.000Z');
  const REVIEW_START = new Date('2026-10-05T19:00:00.000Z');
  const EARLIER = new Date('2026-10-01T12:00:00.000Z');
  let juniperId: string;

  beforeEach(async () => {
    vi.stubEnv('PARENT_CALENDAR_MIRROR_ENABLED', 'true');
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await db.database
      .update(schema.users)
      .set({ timezone: KID_TZ })
      .where(eq(schema.users.id, family.parentUserId));
    const [child] = await db.database
      .insert(schema.children)
      .values({ familyId: family.familyId, name: 'Juniper', dateOfBirth: '2022-03-01' })
      .returning({ id: schema.children.id });
    juniperId = child?.id ?? '';
  });

  function lesson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'ev-lesson',
      status: 'confirmed',
      summary: 'Juniper swim lesson',
      start: { dateTime: LESSON_START.toISOString() },
      end: { dateTime: LESSON_END.toISOString() },
      ...overrides,
    };
  }

  function review(): Record<string, unknown> {
    return {
      id: 'ev-review',
      status: 'confirmed',
      summary: 'Quarterly budget review',
      start: { dateTime: REVIEW_START.toISOString() },
      end: { dateTime: '2026-10-05T20:00:00.000Z' },
    };
  }

  const JUDGE_RULES = {
    'Juniper swim lesson': { verdict: 'kid' as const, childName: 'Juniper' },
    'Quarterly budget review': { verdict: 'adult' as const },
  };

  function model(client: ReturnType<typeof scriptedKidClient>['client']): CalendarMirrorKidJudge {
    return { mode: 'model', client, deadline: NO_DEADLINE };
  }

  function gate(
    items: readonly Record<string, unknown>[],
    kidJudge: CalendarMirrorKidJudge,
    trustWindow = true,
  ) {
    return reconcileCalendarMirrors(db.database, {
      familyId: family.familyId,
      userId: family.parentUserId,
      integrationId,
      items,
      timeZone: KID_TZ,
      now: NOW,
      trustWindow,
      kidJudge,
    });
  }

  /** The shipped reminder deps, narrowed to this test's family. */
  function reminderDeps() {
    return {
      ...defaultReminderRunDeps(),
      scopeFamilies: <T extends { familyId: string }>(list: readonly T[]) =>
        list.filter((row) => row.familyId === family.familyId),
    };
  }

  function verdicts() {
    return db.database
      .select()
      .from(schema.kidRelevanceVerdicts)
      .where(eq(schema.kidRelevanceVerdicts.familyId, family.familyId));
  }

  function reminders() {
    return db.database
      .select()
      .from(schema.eventReminders)
      .where(eq(schema.eventReminders.familyId, family.familyId));
  }

  async function seedMirror(values: {
    eventId: string;
    title: string;
    startsAt: Date;
    endsAt?: Date;
    deletedAt?: Date;
    kidVerdictId?: string;
  }): Promise<string> {
    const [row] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId: family.familyId,
        title: values.title,
        startsAt: values.startsAt,
        endsAt: values.endsAt ?? null,
        source: 'parent',
        createdBy: family.parentUserId,
        googleEventId: values.eventId,
        integrationId,
        deletedAt: values.deletedAt ?? null,
        kidVerdictId: values.kidVerdictId ?? null,
      })
      .returning({ id: schema.familyEvents.id });
    if (!row) throw new Error('mirror seed returned no row');
    return row.id;
  }

  async function seedScheduledReminders(eventRef: string) {
    await db.database.insert(schema.eventReminders).values(
      (['-P1D', '-PT1H'] as const).map((offset) => ({
        familyId: family.familyId,
        eventRef,
        parentUserId: family.parentUserId,
        offset,
        fireAt: new Date(LESSON_START.getTime() - 60 * 60_000),
        status: 'scheduled' as const,
      })),
    );
  }

  async function seedVerdict(values: {
    itemKey: string;
    verdict: 'kid' | 'adult';
    decidedBy: 'parent' | 'model';
  }): Promise<string> {
    const [row] = await db.database
      .insert(schema.kidRelevanceVerdicts)
      .values({
        familyId: family.familyId,
        source: 'google_calendar',
        integrationId,
        itemKey: values.itemKey,
        inputHash: 'an-earlier-input',
        verdict: values.verdict,
        decidedBy: values.decidedBy,
      })
      .returning({ id: schema.kidRelevanceVerdicts.id });
    if (!row) throw new Error('verdict seed returned no row');
    return row.id;
  }

  it('T1: an adult event is not mirrored and schedules no reminder; the kid event in the same window schedules both', async () => {
    const { client } = scriptedKidClient(JUDGE_RULES);

    const counts = await gate([lesson(), review()], model(client));

    expect(counts).toMatchObject({ mirrored: 1, notKid: 1, unjudged: 0, unjudgedNoJudge: 0 });
    const stored = await rows();
    expect(stored).toHaveLength(1);
    const kidVerdict = (await verdicts()).find((row) => row.verdict === 'kid');
    expect(kidVerdict).toBeDefined();
    expect(stored[0]).toMatchObject({
      googleEventId: 'ev-lesson',
      kidVerdictId: kidVerdict?.id,
      childId: juniperId,
      deletedAt: null,
    });
    expect(stored.some((row) => row.googleEventId === 'ev-review')).toBe(false);
    expect(stored.some((row) => row.title.toLowerCase().includes('budget'))).toBe(false);

    const result = await runReminderCron(db.database, reminderDeps(), NOW);

    const scheduled = await reminders();
    expect(scheduled.map((row) => [row.eventRef, row.offset]).sort()).toEqual(
      [
        [stored[0]?.id, '-P1D'],
        [stored[0]?.id, '-PT1H'],
      ].sort(),
    );
    expect(result.notScheduledNoKidVerdict).toBe(0);
  });

  it('T2: a judge failure writes nothing, schedules nothing, and names the outcome in counts only', async () => {
    const { client, calls } = scriptedKidClient('throw');
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const counts = await gate([lesson()], model(client));

    expect(counts).toMatchObject({ mirrored: 0, notKid: 0, unjudged: 1, unjudgedNoJudge: 0 });
    expect(await rows()).toEqual([]);
    // A failure is never a verdict: nothing is stored for it.
    expect(await verdicts()).toEqual([]);
    // Positive control: the judge was really asked, its first attempt and its one retry.
    expect(calls).toHaveLength(2);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ unjudged: 1, judge: 'model' }),
      'calendar mirror: kid gate',
    );
    const logged = JSON.stringify([...info.mock.calls, ...error.mock.calls]);
    expect(logged).toContain('calendar mirror: kid gate');
    expect(logged).not.toContain('swim');
    expect(logged).not.toContain('ev-lesson');
    const gateLog = info.mock.calls.find((call) => call[1] === 'calendar mirror: kid gate');
    expect(JSON.stringify(gateLog)).not.toContain(family.familyId);
    expect(JSON.stringify(gateLog)).not.toContain(integrationId);

    await runReminderCron(db.database, reminderDeps(), NOW);
    expect(await reminders()).toEqual([]);
  });

  it('T3: a live copy judged adult is dropped once, audited as not_kid, and its reminders are cancelled', async () => {
    const reviewId = await seedMirror({
      eventId: 'ev-review',
      title: 'Quarterly budget review',
      startsAt: REVIEW_START,
    });
    await seedScheduledReminders(reviewId);
    const lessonId = await seedMirror({
      eventId: 'ev-lesson',
      title: 'Juniper swim lesson',
      startsAt: LESSON_START,
      endsAt: LESSON_END,
    });
    const { client } = scriptedKidClient(JUDGE_RULES);

    const counts = await gate([lesson(), review()], model(client), true);

    expect(counts).toMatchObject({ removed: 1, notKid: 1, mirrored: 0 });
    const byId = new Map((await rows()).map((row) => [row.id, row]));
    expect(byId.get(reviewId)).toMatchObject({ deletedAt: NOW, title: '' });
    const kidVerdict = (await verdicts()).find((row) => row.verdict === 'kid');
    // Control: the kid copy judged in the same call stays live and becomes linked.
    expect(byId.get(lessonId)).toMatchObject({
      deletedAt: null,
      kidVerdictId: kidVerdict?.id,
      childId: juniperId,
    });
    const removed = (await audits()).filter((row) => row.actionTaken === 'calendar_mirror_removed');
    expect(removed).toHaveLength(1);
    expect(removed[0]).toMatchObject({
      targetId: reviewId,
      after: { source: 'parent', reason: 'not_kid' },
    });
    // The link-only change to the kid copy is bookkeeping, not an audited change.
    expect((await audits()).map((row) => row.actionTaken)).toEqual(['calendar_mirror_removed']);

    await runReminderCron(db.database, reminderDeps(), NOW);
    const reviewReminders = (await reminders()).filter((row) => row.eventRef === reviewId);
    expect(reviewReminders.map((row) => row.status)).toEqual(['cancelled', 'cancelled']);
  });

  it('T4: a copy the parent disowned stays dropped, with no judge call and no audit row', async () => {
    const verdictId = await seedVerdict({
      itemKey: 'ev-review',
      verdict: 'adult',
      decidedBy: 'parent',
    });
    const reviewId = await seedMirror({
      eventId: 'ev-review',
      title: '',
      startsAt: REVIEW_START,
      deletedAt: EARLIER,
    });
    const judged = scriptedKidClient({ 'Quarterly budget review': { verdict: 'kid' } });

    const counts = await gate([review()], model(judged.client), true);

    expect(counts).toMatchObject({ notKid: 1, removed: 0, mirrored: 0, updated: 0 });
    expect(judged.calls).toHaveLength(0);
    const [row] = await rows();
    expect(row).toMatchObject({ id: reviewId, title: '', deletedAt: EARLIER });
    expect(await audits()).toEqual([]);

    // Control: with the parent's word gone and the model saying kid, the restore path
    // still exists.
    await db.database
      .delete(schema.kidRelevanceVerdicts)
      .where(eq(schema.kidRelevanceVerdicts.id, verdictId));
    const restored = await gate([review()], model(judged.client), true);
    expect(restored).toMatchObject({ notKid: 0, updated: 1 });
    expect(judged.calls).toHaveLength(1);
    const [live] = await rows();
    expect(live).toMatchObject({ id: reviewId, deletedAt: null, title: 'Quarterly budget review' });
    expect((await audits()).map((audit) => audit.actionTaken)).toEqual(['calendar_mirror_added']);
  });

  it('T5: a held judgement keeps the copy with its old title, clears its stale link, and holds its reminders', async () => {
    const verdictId = await seedVerdict({
      itemKey: 'ev-lesson',
      verdict: 'kid',
      decidedBy: 'model',
    });
    const lessonId = await seedMirror({
      eventId: 'ev-lesson',
      title: 'Juniper swim lesson',
      startsAt: LESSON_START,
      endsAt: LESSON_END,
      kidVerdictId: verdictId,
    });
    await seedScheduledReminders(lessonId);
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { client } = scriptedKidClient('throw');

    const counts = await gate(
      [lesson({ summary: 'Juniper swim lesson at the new pool' })],
      model(client),
      true,
    );

    expect(counts).toMatchObject({ unjudged: 1, removed: 0, updated: 0, mirrored: 0 });
    const [row] = await db.database
      .select()
      .from(schema.familyEvents)
      .where(eq(schema.familyEvents.id, lessonId));
    expect(row).toMatchObject({
      deletedAt: null,
      title: 'Juniper swim lesson',
      kidVerdictId: null,
    });

    const result = await runReminderCron(db.database, reminderDeps(), NOW);
    expect((await reminders()).map((r) => r.status)).toEqual(['scheduled', 'scheduled']);
    expect(result.notScheduledNoKidVerdict).toBe(2);
  });
});
