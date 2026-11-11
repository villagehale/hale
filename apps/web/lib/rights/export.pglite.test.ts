import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ACTIVITY_HELD_TOPIC } from '~/lib/channel/activity/venue-pages';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { assembleFamilyExport } from './export';
import { ACCESS_EXPORT_ROUND_2_ENABLED_ENV } from './export-round-2';

/**
 * The access copy against real Postgres, for the one block nothing else can see.
 *
 * export.test.ts fakes the database and routes each select by call order, which means it
 * can prove the document's SHAPE and nothing about the queries behind it — a note read
 * that was scoped to the wrong column, or to the whole family, would pass it. Day notes
 * are a parent's own unedited words and the one thing in this product deliberately kept
 * off every shared surface (rule #1), so the scoping is the part that has to be true.
 */

const TZ = 'America/Toronto';
const NOTED_AT = new Date('2026-07-06T01:40:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users cascade');
});

async function seedParent(familyId: string, suffix: string, role: 'primary_parent' | 'co_parent') {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${familyId}:${suffix}`, name: suffix, timezone: TZ })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({ familyId, userId, role });
  return userId;
}

async function seedNote(input: {
  familyId: string;
  parentUserId: string;
  notedOn: string;
  note: string;
}) {
  const [inbound] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      channel: 'sms',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      body: input.note,
    })
    .returning({ id: schema.channelMessages.id });
  await db.database.insert(schema.familyCheckInNotes).values({
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    sourceMessageId: inbound?.id as string,
    notedOn: input.notedOn,
    note: input.note,
    expiresAt: new Date(NOTED_AT.getTime() + 30 * 24 * 3_600_000),
  });
}

describe('the evening check-in in a right-to-access copy', () => {
  it("gives a parent their own day notes and never their co-parent's", async () => {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Ana + kids', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    const familyId = family?.id as string;
    const anaId = await seedParent(familyId, 'ana', 'primary_parent');
    const samId = await seedParent(familyId, 'sam', 'co_parent');

    await db.database.insert(schema.familyCheckInPrefs).values({
      familyId,
      cadence: 'weekly',
      lastAskedAt: new Date('2026-07-06T00:17:00.000Z'),
      lastAnsweredAt: NOTED_AT,
    });
    await seedNote({
      familyId,
      parentUserId: anaId,
      notedOn: '2026-07-05',
      note: 'Park after daycare and both asleep by 7',
    });
    await seedNote({
      familyId,
      parentUserId: samId,
      notedOn: '2026-07-04',
      note: 'Long one, I was at the office until eight',
    });

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: anaId,
      loadTrail: async () => [],
    });

    expect(doc.eveningCheckIn.cadence).toBe('weekly');
    expect(doc.eveningCheckIn.lastAnsweredAt).toBe(NOTED_AT.toISOString());
    expect(doc.eveningCheckIn.notes.map((entry) => entry.note)).toEqual([
      'Park after daycare and both asleep by 7',
    ]);
    expect(JSON.stringify(doc)).not.toContain('until eight');
  });

  /**
   * ONE PARENT'S TRIP MUST NOT REACH THE OTHER, and the export is the only surface where
   * it could. Every other fact about a trip says it belongs to one parent — detected from
   * ONE mailbox, texted to THAT phone, cascading on THAT user's row — and this file is the
   * one durable copy that leaves the app. Hale supports separated co-parents, so a solo
   * travel date is exactly the disclosure the privacy moat exists to prevent.
   *
   * THE POSITIVE CONTROL IS THE TEST. `trips: []` passes just as happily on a block that
   * is always empty, so the same trip is read back as its own parent in the same `it`.
   */
  it('serves a trip only to the parent whose mailbox it came from', async () => {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Ana + Sam', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    const familyId = family?.id as string;
    const anaId = await seedParent(familyId, 'ana', 'primary_parent');
    const samId = await seedParent(familyId, 'sam', 'co_parent');

    await db.database.insert(schema.familyTrips).values({
      familyId,
      parentUserId: anaId,
      integrationId: '99999999-9999-4999-8999-999999999999',
      messageId: 'gmail-trip-1',
      destinationCity: 'New York',
      destinationRegion: 'NY',
      startsOn: '2026-09-12',
      endsOn: '2026-09-15',
      childEvidence: 'named_traveller',
    });

    const sams = await assembleFamilyExport(db.database, familyId, {
      actorUserId: samId,
      loadTrail: async () => [],
    });
    expect(sams.trips).toEqual([]);
    // Not just the block: nowhere in Sam's whole copy.
    expect(JSON.stringify(sams)).not.toContain('New York');

    const anas = await assembleFamilyExport(db.database, familyId, {
      actorUserId: anaId,
      loadTrail: async () => [],
    });
    expect(anas.trips).toEqual([
      {
        destinationCity: 'New York',
        destinationRegion: 'NY',
        startsOn: '2026-09-12',
        endsOn: '2026-09-15',
        childEvidence: 'named_traveller',
        closedAt: null,
        closedReason: null,
      },
    ]);
  });
});

/**
 * VIL-423 · a watch on a link the parent sent has no catalog window behind it, so the
 * preparation block must not assume one. A right-to-access copy that silently drops the
 * one standing instruction Hale holds for a family is the PIPEDA failure; one that shows
 * it to another family is the privacy failure. Both are queries, so both are proven here.
 */
describe('a link-owned registration watch in a right-to-access copy', () => {
  it("is in its own family's copy, host only, and in no other family's", async () => {
    const a = await seedFamily(db.database, 'Watch Export A');
    const b = await seedFamily(db.database, 'Watch Export B');
    await db.database.insert(schema.registrationSequences).values([
      {
        familyId: a.familyId,
        parentUserId: a.parentUserId,
        courseUrl: 'https://courses.example.net/term/swim?session=x7k2',
        lastReadAt: new Date('2026-10-01T15:00:00Z'),
        nextCheckAt: new Date('2026-10-02T15:00:00Z'),
        updatedAt: new Date('2026-10-01T15:00:00Z'),
      },
      {
        familyId: b.familyId,
        parentUserId: b.parentUserId,
        courseUrl: 'https://signup.example.com/class/42',
        pausedAt: new Date('2026-10-03T12:00:00Z'),
        pendingChange: { opensAt: 'pending-body-q9' },
      },
    ]);

    const docA = await assembleFamilyExport(db.database, a.familyId, {
      actorUserId: a.parentUserId,
      loadTrail: async () => [],
    });
    expect(docA.registrationPreparation).toEqual([
      {
        municipality: null,
        cycleLabel: null,
        courseHost: 'courses.example.net',
        courseOpensAt: null,
        readinessReady: null,
        lastReadAt: '2026-10-01T15:00:00.000Z',
        nextCheckAt: '2026-10-02T15:00:00.000Z',
        pausedAt: null,
        hasPendingChange: false,
        updatedAt: '2026-10-01T15:00:00.000Z',
      },
    ]);
    const serializedA = JSON.stringify(docA);
    expect(serializedA).not.toContain('session=x7k2');
    expect(serializedA).not.toContain('/term/swim');

    const docB = await assembleFamilyExport(db.database, b.familyId, {
      actorUserId: b.parentUserId,
      loadTrail: async () => [],
    });
    expect(docB.registrationPreparation.map((entry) => entry.courseHost)).toEqual([
      'signup.example.com',
    ]);
    expect(JSON.stringify(docB)).not.toContain('courses.example.net');

    // A's watch is unpaused with nothing pending, B's is paused with a change pending, so
    // each of the two mappings must read its own column: a constant in either is red on
    // one family or the other. Only the presence of the change leaves, never its body.
    expect(
      docB.registrationPreparation.map(({ pausedAt, hasPendingChange }) => ({
        pausedAt,
        hasPendingChange,
      })),
    ).toEqual([{ pausedAt: '2026-10-03T12:00:00.000Z', hasPendingChange: true }]);
    expect(JSON.stringify(docB)).not.toContain('pending-body-q9');
  });
});

/**
 * One adult's own records: their 1:1 text thread with Hale, the language Hale writes to
 * them in, and the audit rows for each time that changed. The family copy leaves these
 * out for everyone (NOT_IN_FAMILY_EXPORT), so without this section the requester gets
 * none of it either. The co-parent's copy is the negative, and the requester's own copy
 * is its positive control: an always-empty section would pass the negative alone.
 */
describe("the requester's own section in a right-to-access copy", () => {
  it('gives each parent their own thread and language rows, and never the other parent', async () => {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Ana + Sam', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    const familyId = family?.id as string;
    const anaId = await seedParent(familyId, 'ana', 'primary_parent');
    const samId = await seedParent(familyId, 'sam', 'co_parent');
    await db.database
      .update(schema.users)
      .set({ proactiveLanguage: 'fr', languageStreakTag: 'es', languageStreakCount: 2 })
      .where(eq(schema.users.id, anaId));

    const thread = async (
      noteKey: string,
      turns: { role: 'user' | 'assistant'; content: string; at: string; deletedAt?: string }[],
    ) => {
      const [conversation] = await db.database
        .insert(schema.conversations)
        .values({ familyId, noteKey })
        .returning({ id: schema.conversations.id });
      await db.database.insert(schema.messages).values(
        turns.map((turn) => ({
          conversationId: conversation?.id as string,
          role: turn.role,
          content: turn.content,
          createdAt: new Date(turn.at),
          deletedAt: turn.deletedAt ? new Date(turn.deletedAt) : null,
        })),
      );
    };
    await thread(channelSmsNoteKey(anaId), [
      { role: 'user', content: 'ana asks about swim on saturday', at: '2026-11-01T14:00:00.000Z' },
      { role: 'assistant', content: 'hale answers ana about swim', at: '2026-11-01T14:00:05.000Z' },
      {
        role: 'user',
        content: 'ana removed this line',
        at: '2026-11-01T14:01:00.000Z',
        deletedAt: '2026-11-02T09:00:00.000Z',
      },
    ]);
    await thread(channelSmsNoteKey(samId), [
      { role: 'user', content: 'sam private question', at: '2026-11-01T15:00:00.000Z' },
    ]);
    await thread('channel-group:chat-x1', [
      { role: 'user', content: 'group carpool chatter', at: '2026-11-01T16:00:00.000Z' },
    ]);
    await db.database.insert(schema.auditLog).values([
      {
        familyId,
        actor: anaId,
        actionTaken: 'parent_language_changed',
        targetTable: 'users',
        targetId: anaId,
        before: { language: 'en' },
        after: { language: 'fr', why: 'asked' },
        occurredAt: new Date('2026-10-20T12:00:00.000Z'),
      },
      {
        familyId,
        actor: samId,
        actionTaken: 'parent_language_changed',
        targetTable: 'users',
        targetId: samId,
        before: { language: 'en' },
        after: { language: 'pt', why: 'sustained' },
        occurredAt: new Date('2026-10-21T12:00:00.000Z'),
      },
    ]);

    const anas = await assembleFamilyExport(db.database, familyId, {
      actorUserId: anaId,
      now: NOTED_AT,
    });
    expect(anas.requesterOnly).toEqual({
      language: { proactiveLanguage: 'fr', languageStreakTag: 'es', languageStreakCount: 2 },
      languageChanges: [
        { changedAt: '2026-10-20T12:00:00.000Z', from: 'en', to: 'fr', why: 'asked' },
      ],
      textThread: [
        {
          role: 'user',
          content: 'ana asks about swim on saturday',
          topic: null,
          sentAt: '2026-11-01T14:00:00.000Z',
          removedAt: null,
        },
        {
          role: 'assistant',
          content: 'hale answers ana about swim',
          topic: null,
          sentAt: '2026-11-01T14:00:05.000Z',
          removedAt: null,
        },
        {
          role: 'user',
          content: 'ana removed this line',
          topic: null,
          sentAt: '2026-11-01T14:01:00.000Z',
          removedAt: '2026-11-02T09:00:00.000Z',
        },
      ],
      consents: [],
      connections: [],
      calendarMirrors: [],
      privateAsides: [],
    });
    const anaText = JSON.stringify(anas);
    expect(anaText).not.toContain('sam private');
    expect(anaText).not.toContain('"pt"');
    // The group thread is the household's, so it is in the shared threads, not here.
    expect(JSON.stringify(anas.requesterOnly)).not.toContain('group carpool');
    expect(anas.sharedThreads.map((t) => [t.kind, t.turns.map((turn) => turn.content)])).toEqual([
      ['group', ['group carpool chatter']],
    ]);

    // The real trail loader, so the whole of Sam's copy is checked, not one block.
    const sams = await assembleFamilyExport(db.database, familyId, {
      actorUserId: samId,
      now: NOTED_AT,
    });
    expect(sams.requesterOnly.textThread.map((turn) => turn.content)).toEqual([
      'sam private question',
    ]);
    expect(sams.requesterOnly.language).toEqual({
      proactiveLanguage: null,
      languageStreakTag: null,
      languageStreakCount: 0,
    });
    expect(sams.requesterOnly.languageChanges).toEqual([
      { changedAt: '2026-10-21T12:00:00.000Z', from: 'en', to: 'pt', why: 'sustained' },
    ]);
    const samText = JSON.stringify(sams);
    expect(samText).not.toContain('ana asks');
    expect(samText).not.toContain('hale answers ana');
    expect(samText).not.toContain('ana removed');
    expect(samText).not.toContain('"fr"');
    expect(samText).not.toContain('2026-10-20T12:00:00');
  });
});

describe('booking and signup-plan columns in a right-to-access copy', () => {
  it('carries the place and street address a booking holds', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Booking Export');
    await db.database.insert(schema.activityBookings).values([
      {
        familyId,
        parentUserId,
        integrationId: '99999999-9999-4999-8999-999999999991',
        messageId: 'gmail-booking-1',
        providerHost: 'rec.example.org',
        title: 'Swim Level 2',
        firstSessionAt: new Date('2026-11-14T15:00:00.000Z'),
        location: 'Northside Pool',
        address: '100 Example Ave',
      },
      {
        familyId,
        parentUserId,
        integrationId: '99999999-9999-4999-8999-999999999991',
        messageId: 'gmail-booking-2',
        providerHost: 'rec.example.org',
        title: 'Art club',
        firstSessionAt: new Date('2026-11-15T15:00:00.000Z'),
      },
    ]);

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentUserId,
      loadTrail: async () => [],
    });
    expect(
      doc.activityBookings.map(({ title, location, address }) => ({ title, location, address })),
    ).toEqual([
      { title: 'Swim Level 2', location: 'Northside Pool', address: '100 Example Ave' },
      { title: 'Art club', location: null, address: null },
    ]);
  });

  it('carries the day-before plan a parent approved for an authorized signup', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Plan Export');
    const [child] = await db.database
      .insert(schema.children)
      .values({ familyId, name: 'Pip', dateOfBirth: '2021-03-01' })
      .returning({ id: schema.children.id });
    await db.database.insert(schema.authorizedSignupOffers).values([
      {
        familyId,
        childId: child?.id as string,
        parentUserId,
        activityKey: 'rec.example.org|swim|2026-11-20',
        registrationUrl: 'https://rec.example.org/register/swim?code=q7',
        sessions: [],
        status: 'planned',
        planChoiceIds: ['s-2', 's-1'],
        planMaxPriceCents: 14200,
        planOpensAt: new Date('2026-11-20T12:00:00.000Z'),
        planWaiverAccepted: true,
        planApprovedAt: new Date('2026-11-19T20:00:00.000Z'),
      },
      {
        familyId,
        childId: child?.id as string,
        parentUserId,
        activityKey: 'rec.example.org|art|2026-11-21',
        registrationUrl: 'https://rec.example.org/register/art',
        sessions: [],
        status: 'pending',
      },
    ]);

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentUserId,
      loadTrail: async () => [],
    });
    expect(
      doc.authorizedSignups.map(
        ({
          status,
          planChoiceIds,
          planMaxPriceCents,
          planOpensAt,
          planWaiverAccepted,
          planApprovedAt,
        }) => ({
          status,
          planChoiceIds,
          planMaxPriceCents,
          planOpensAt,
          planWaiverAccepted,
          planApprovedAt,
        }),
      ),
    ).toEqual([
      {
        status: 'planned',
        planChoiceIds: ['s-2', 's-1'],
        planMaxPriceCents: 14200,
        planOpensAt: '2026-11-20T12:00:00.000Z',
        planWaiverAccepted: true,
        planApprovedAt: '2026-11-19T20:00:00.000Z',
      },
      {
        status: 'pending',
        planChoiceIds: null,
        planMaxPriceCents: null,
        planOpensAt: null,
        planWaiverAccepted: null,
        planApprovedAt: null,
      },
    ]);
  });
});

describe('access export round 2 on the requester thread and bookings', () => {
  const INTEGRATION = '99999999-9999-4999-8999-999999999991';
  const HELD = '{"unsent_activity_options":[{"name":"held-only-class"}]}';

  it('leaves a coach-only held note out of the requester thread when lit', async () => {
    vi.stubEnv(ACCESS_EXPORT_ROUND_2_ENABLED_ENV, 'true');
    const { familyId, parentUserId } = await seedFamily(db.database, 'Held Note Export');
    const [conversation] = await db.database
      .insert(schema.conversations)
      .values({ familyId, noteKey: channelSmsNoteKey(parentUserId) })
      .returning({ id: schema.conversations.id });
    await db.database.insert(schema.messages).values([
      {
        conversationId: conversation?.id as string,
        role: 'assistant',
        content: 'the text that went out',
        createdAt: new Date('2026-11-01T14:00:00.000Z'),
      },
      {
        conversationId: conversation?.id as string,
        role: 'assistant',
        content: HELD,
        topic: ACTIVITY_HELD_TOPIC,
        createdAt: new Date('2026-11-01T14:00:05.000Z'),
      },
    ]);

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentUserId,
      loadTrail: async () => [],
    });
    expect(doc.requesterOnly.textThread.map((turn) => turn.content)).toEqual([
      'the text that went out',
    ]);
    expect(JSON.stringify(doc.requesterOnly)).not.toContain('held-only-class');
    expect(JSON.stringify(doc.requesterOnly)).not.toContain(ACTIVITY_HELD_TOPIC);
  });

  it('keeps a held note in the requester thread when unlit', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Held Note Unlit');
    const [conversation] = await db.database
      .insert(schema.conversations)
      .values({ familyId, noteKey: channelSmsNoteKey(parentUserId) })
      .returning({ id: schema.conversations.id });
    await db.database.insert(schema.messages).values({
      conversationId: conversation?.id as string,
      role: 'assistant',
      content: HELD,
      topic: ACTIVITY_HELD_TOPIC,
      createdAt: new Date('2026-11-01T14:00:05.000Z'),
    });

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentUserId,
      loadTrail: async () => [],
    });
    expect(doc.requesterOnly.textThread.map((turn) => turn.content)).toEqual([HELD]);
  });

  it("gives a parent their own bookings and never the co-parent's when lit", async () => {
    vi.stubEnv(ACCESS_EXPORT_ROUND_2_ENABLED_ENV, 'true');
    const { familyId, parentUserId: parentA } = await seedFamily(db.database, 'Booking Scope');
    const parentB = await seedParent(familyId, 'coparent', 'co_parent');
    await db.database.insert(schema.activityBookings).values([
      {
        familyId,
        parentUserId: parentA,
        integrationId: INTEGRATION,
        messageId: 'gmail-a',
        providerHost: 'rec.example.org',
        title: 'A swim',
        firstSessionAt: new Date('2026-11-14T15:00:00.000Z'),
        location: 'Northside Pool',
        address: '100 Example Ave',
      },
      {
        familyId,
        parentUserId: parentB,
        integrationId: INTEGRATION,
        messageId: 'gmail-b',
        providerHost: 'rec.example.org',
        title: 'B private art',
        firstSessionAt: new Date('2026-11-15T15:00:00.000Z'),
        address: 'B private street',
      },
    ]);

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentA,
      loadTrail: async () => [],
    });
    expect(doc.activityBookings).toEqual([
      expect.objectContaining({
        title: 'A swim',
        location: 'Northside Pool',
        address: '100 Example Ave',
      }),
    ]);
    expect(JSON.stringify(doc.activityBookings)).not.toContain('B private');
  });

  it("redacts a 13+ child's name in a booking title when lit", async () => {
    vi.stubEnv(ACCESS_EXPORT_ROUND_2_ENABLED_ENV, 'true');
    const { familyId, parentUserId } = await seedFamily(db.database, 'Teen Booking');
    await db.database.insert(schema.children).values({
      familyId,
      name: 'Tamsin',
      dateOfBirth: '2012-02-01',
    });
    await db.database.insert(schema.activityBookings).values({
      familyId,
      parentUserId,
      integrationId: INTEGRATION,
      messageId: 'gmail-teen',
      providerHost: 'rec.example.org',
      title: "Tamsin's swim",
      firstSessionAt: new Date('2026-11-14T15:00:00.000Z'),
    });

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentUserId,
      loadTrail: async () => [],
      now: new Date('2026-11-08T15:00:00.000Z'),
    });
    expect(doc.activityBookings.map((row) => row.title)).toEqual([TEEN_REDACTED_PLACEHOLDER]);
    expect(JSON.stringify(doc.activityBookings)).not.toContain('Tamsin');
  });
});
