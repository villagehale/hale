import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { channelGroupNoteKey, channelSmsNoteKey } from '~/lib/coach/note-key';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import { TEEN_NAME_SHARED_MATCHER_ENABLED_ENV } from '~/lib/privacy/teen-name';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { assembleFamilyExport } from './export';

/**
 * VIL-622 · the household calendar, the shared threads, the group lists and the
 * requester's consent rows in a right-to-access copy, against real Postgres.
 */

const NOW = new Date('2026-11-08T15:00:00.000Z');
const TEEN_NAME = 'Tamsin';

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

async function seedAdult(familyId: string, suffix: string, role: 'co_parent' | null) {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${familyId}:${suffix}`, name: `Name-${suffix}` })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  if (role) await db.database.insert(schema.familyMembers).values({ familyId, userId, role });
  return userId;
}

async function seedHousehold() {
  const { familyId, parentUserId: parentA } = await seedFamily(db.database);
  const parentB = await seedAdult(familyId, 'coparent', 'co_parent');
  const [kid, teen] = await db.database
    .insert(schema.children)
    .values([
      { familyId, name: 'Pip', dateOfBirth: '2023-01-10' },
      { familyId, name: TEEN_NAME, dateOfBirth: '2012-02-01' },
    ])
    .returning({ id: schema.children.id });
  return { familyId, parentA, parentB, kidId: kid?.id as string, teenId: teen?.id as string };
}

async function conversation(familyId: string, noteKey: string | null, createdAt?: Date) {
  const [row] = await db.database
    .insert(schema.conversations)
    .values({ familyId, noteKey, createdAt })
    .returning({ id: schema.conversations.id });
  return row?.id as string;
}

describe('the household calendar in a right-to-access copy', () => {
  it("carries the household's events, withholds a teen's, and keeps each parent's mirror theirs", async () => {
    const { familyId, parentA, parentB, kidId, teenId } = await seedHousehold();
    const integration = async (userId: string) => {
      const [row] = await db.database
        .insert(schema.integrations)
        .values({ familyId, userId, provider: 'gcal' })
        .returning({ id: schema.integrations.id });
      return row?.id as string;
    };
    const gcalA = await integration(parentA);
    const gcalB = await integration(parentB);
    await db.database.insert(schema.familyEvents).values([
      {
        familyId,
        childId: kidId,
        title: 'swim lesson',
        startsAt: new Date('2026-11-14T15:00:00.000Z'),
        location: 'the pool',
        source: 'placement',
        dutyOwnerLabel: 'Grandma',
        dutyOwnerKind: 'named',
        dutyRole: 'pickup',
      },
      {
        familyId,
        childId: teenId,
        title: 'teen raw appointment',
        startsAt: new Date('2026-11-15T15:00:00.000Z'),
        location: 'teen raw place',
        source: 'channel',
      },
      {
        familyId,
        title: 'party cancelled',
        startsAt: new Date('2026-11-16T15:00:00.000Z'),
        source: 'parent',
        deletedAt: new Date('2026-11-07T00:00:00.000Z'),
      },
      {
        familyId,
        title: 'A dentist',
        startsAt: new Date('2026-11-17T15:00:00.000Z'),
        source: 'email',
        googleEventId: 'g-a',
        integrationId: gcalA,
      },
      {
        familyId,
        title: 'B private dinner',
        startsAt: new Date('2026-11-18T15:00:00.000Z'),
        source: 'email',
        googleEventId: 'g-b',
        integrationId: gcalB,
      },
    ]);

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentA,
      loadTrail: async () => [],
      now: NOW,
    });

    expect(doc.calendarEvents.map((e) => [e.title, e.location, e.child, e.withheld])).toEqual([
      ['swim lesson', 'the pool', 'Pip', null],
      [TEEN_REDACTED_PLACEHOLDER, null, null, 'teen'],
      ['party cancelled', null, null, null],
    ]);
    expect(doc.calendarEvents[0]?.duty).toEqual({
      label: 'Grandma',
      kind: 'named',
      role: 'pickup',
    });
    expect(doc.calendarEvents[2]?.cancelledAt).toBe('2026-11-07T00:00:00.000Z');
    expect(doc.requesterOnly.calendarMirrors.map((e) => e.title)).toEqual(['A dentist']);
    expect(doc.requesterOnly.connections).toEqual([
      expect.objectContaining({ provider: 'gcal', status: 'connecting', lastSyncAt: null }),
    ]);
    const text = JSON.stringify(doc);
    expect(text).not.toContain('teen raw');
    expect(text).not.toContain('B private');
  });

  it("lit, withholds a duty owner label that names a teen, and keeps a younger sibling's", async () => {
    vi.stubEnv(TEEN_NAME_SHARED_MATCHER_ENABLED_ENV, 'true');
    const { familyId, parentA, kidId } = await seedHousehold();
    await db.database.insert(schema.familyEvents).values([
      {
        familyId,
        childId: kidId,
        title: 'swim lesson',
        startsAt: new Date('2026-11-14T15:00:00.000Z'),
        source: 'placement',
        dutyOwnerLabel: `${TEEN_NAME} picks up Pip`,
        dutyOwnerKind: 'named',
        dutyRole: 'pickup',
      },
      {
        familyId,
        childId: kidId,
        title: 'library morning',
        startsAt: new Date('2026-11-15T15:00:00.000Z'),
        source: 'placement',
        dutyOwnerLabel: 'Pip',
        dutyOwnerKind: 'named',
        dutyRole: 'pickup',
      },
    ]);

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentA,
      loadTrail: async () => [],
      now: NOW,
    });

    expect(doc.calendarEvents.map((e) => [e.title, e.duty, e.withheld])).toEqual([
      [TEEN_REDACTED_PLACEHOLDER, null, 'teen'],
      ['library morning', { label: 'Pip', kind: 'named', role: 'pickup' }, null],
    ]);
    expect(JSON.stringify(doc)).not.toContain(`${TEEN_NAME} picks up`);
  });
});

describe('the shared threads in a right-to-access copy', () => {
  it("carries the family's shared threads and never another parent's 1:1", async () => {
    const { familyId, parentA, parentB, teenId } = await seedHousehold();
    const ask = await conversation(familyId, null, new Date('2026-10-01T00:00:00.000Z'));
    const group = await conversation(
      familyId,
      channelGroupNoteKey('chat-1'),
      new Date('2026-10-02T00:00:00.000Z'),
    );
    const ownThread = await conversation(familyId, channelSmsNoteKey(parentA));
    const otherThread = await conversation(familyId, channelSmsNoteKey(parentB));
    const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 12, minute));
    await db.database.insert(schema.messages).values([
      { conversationId: ask, role: 'user', content: 'what is on this weekend', createdAt: at(1) },
      { conversationId: ask, role: 'assistant', content: 'a library morning', createdAt: at(2) },
      {
        conversationId: ask,
        role: 'user',
        content: 'removed words',
        createdAt: at(3),
        deletedAt: at(4),
      },
      {
        conversationId: ask,
        role: 'user',
        content: 'teen raw question',
        childId: teenId,
        createdAt: at(5),
      },
      { conversationId: group, role: 'user', content: 'who has pickup', createdAt: at(6) },
      { conversationId: ownThread, role: 'user', content: 'A own text', createdAt: at(7) },
      { conversationId: otherThread, role: 'user', content: 'B private text', createdAt: at(8) },
    ]);

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentA,
      loadTrail: async () => [],
      now: NOW,
    });

    expect(
      doc.sharedThreads.map((t) => [t.kind, t.turns.map((turn) => [turn.content, turn.withheld])]),
    ).toEqual([
      [
        'ask',
        [
          ['what is on this weekend', null],
          ['a library morning', null],
          [null, null],
          [TEEN_REDACTED_PLACEHOLDER, 'teen'],
        ],
      ],
      ['group', [['who has pickup', null]]],
    ]);
    expect(doc.sharedThreads[0]?.turns[2]?.removedAt).toBe(at(4).toISOString());
    expect(doc.requesterOnly.textThread.map((turn) => turn.content)).toEqual(['A own text']);
    const text = JSON.stringify(doc);
    expect(text).not.toContain('B private');
    expect(text).not.toContain('removed words');
    expect(text).not.toContain('teen raw');
  });
});

describe('group lists in a right-to-access copy', () => {
  it('carries each list and its items, and names no adult from another household', async () => {
    const { familyId, parentA, parentB } = await seedHousehold();
    const { familyId: otherFamilyId } = await seedFamily(db.database, 'Other household');
    const neighbour = await seedAdult(otherFamilyId, 'neighbour', null);
    await db.database
      .insert(schema.familyMembers)
      .values({ familyId: otherFamilyId, userId: neighbour, role: 'co_parent' });
    const group = await conversation(familyId, channelGroupNoteKey('chat-2'));
    const [list] = await db.database
      .insert(schema.groupLists)
      .values({
        familyId,
        conversationId: group,
        name: 'groceries',
        nameKey: 'groceries',
        createdByUserId: neighbour,
        createdAt: new Date('2026-11-01T12:00:00.000Z'),
      })
      .returning({ id: schema.groupLists.id });
    const listId = list?.id as string;
    await db.database.insert(schema.groupListItems).values([
      {
        listId,
        text: 'milk',
        textKey: 'milk',
        addedByUserId: parentA,
        addedAt: new Date('2026-11-01T12:01:00.000Z'),
        checkedAt: new Date('2026-11-02T12:00:00.000Z'),
        checkedByUserId: parentB,
      },
      {
        listId,
        text: 'bread',
        textKey: 'bread',
        addedByUserId: neighbour,
        addedAt: new Date('2026-11-01T12:02:00.000Z'),
      },
      {
        listId,
        text: `${TEEN_NAME} cleats`,
        textKey: 'cleats',
        addedByUserId: parentB,
        addedAt: new Date('2026-11-01T12:03:00.000Z'),
      },
    ]);

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentA,
      loadTrail: async () => [],
      now: NOW,
    });

    expect(doc.groupLists).toEqual([
      {
        name: 'groceries',
        createdBy: 'another_household',
        createdAt: '2026-11-01T12:00:00.000Z',
        archivedAt: null,
        withheld: null,
        items: [
          {
            text: 'milk',
            addedBy: 'you',
            addedAt: '2026-11-01T12:01:00.000Z',
            checkedAt: '2026-11-02T12:00:00.000Z',
            checkedBy: 'your_household',
            withheld: null,
          },
          {
            text: 'bread',
            addedBy: 'another_household',
            addedAt: '2026-11-01T12:02:00.000Z',
            checkedAt: null,
            checkedBy: null,
            withheld: null,
          },
          {
            text: TEEN_REDACTED_PLACEHOLDER,
            addedBy: 'your_household',
            addedAt: '2026-11-01T12:03:00.000Z',
            checkedAt: null,
            checkedBy: null,
            withheld: 'teen',
          },
        ],
      },
    ]);
    const text = JSON.stringify(doc.groupLists);
    expect(text).not.toContain('Name-');
    expect(text).not.toContain(neighbour);
    expect(text).not.toContain(TEEN_NAME);
  });
});

describe("the requester's consent records in a right-to-access copy", () => {
  it('gives a parent their own consent rows, and never the other parent', async () => {
    const { familyId, parentA, parentB, teenId } = await seedHousehold();
    await db.database.insert(schema.consentRecords).values([
      {
        familyId,
        userId: parentA,
        consentType: 'sms_service_messages',
        granted: true,
        grantedAt: new Date('2026-10-01T12:00:00.000Z'),
        policyVersion: 'v1',
        evidence: { reply: 'yes please' },
      },
      {
        familyId,
        userId: parentA,
        consentType: 'teen_content_access',
        consentScope: 'messages',
        granted: false,
        grantedAt: new Date('2026-10-02T12:00:00.000Z'),
        expiresAt: new Date('2026-10-03T12:00:00.000Z'),
        policyVersion: 'v1',
        evidence: { reason: 'teen raw reason', teenChildId: teenId },
      },
      {
        familyId,
        userId: parentB,
        consentType: 'sms_service_messages',
        granted: true,
        grantedAt: new Date('2026-10-04T12:00:00.000Z'),
        policyVersion: 'v1',
        evidence: { reply: 'B private yes' },
      },
    ]);

    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentA,
      loadTrail: async () => [],
      now: NOW,
    });

    expect(doc.requesterOnly.consents).toEqual([
      expect.objectContaining({
        type: 'sms_service_messages',
        granted: true,
        grantedAt: '2026-10-01T12:00:00.000Z',
        evidence: { reply: 'yes please' },
        withheld: null,
      }),
      expect.objectContaining({
        type: 'teen_content_access',
        scope: 'messages',
        granted: false,
        expiresAt: '2026-10-03T12:00:00.000Z',
        evidence: null,
        withheld: 'teen',
      }),
    ]);
    const text = JSON.stringify(doc);
    expect(text).not.toContain('B private');
    expect(text).not.toContain('teen raw');
    // The children block names every child by id; the consent rows must not.
    expect(JSON.stringify(doc.requesterOnly)).not.toContain(teenId);
  });
});
