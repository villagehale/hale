import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  joinFamilyToSharedGroup,
  noticeSharedGroupAdded,
  readFamilySliceForAudience,
  takeMultiFamilyReaction,
  takeMultiFamilyTurn,
  unseatMultiFamilyMember,
} from './multi-family';
import type { ListChatHandles } from './roster';
import type { SharedGroupReader, SharedGroupReading } from './shared-group-reading';
import { fakeSharedGroupComposer } from './shared-group-voice-fake';

const KEY = Buffer.alloc(32, 7).toString('base64');
const FROM = '+16462352164';
const NOW = new Date('2026-10-28T15:00:00.000Z');
const CHAT = 'chat-shared-group';
const CHILD = 'Zephyrina';
const MEMORY = 'zephyr-memory-token';
const CALENDAR = 'zephyr-calendar-token';

const MEI = '+16415550101';
const TOM = '+16415550102';
const ADA = '+16415550201';
const JORDAN = '+16415550202';
const PRIYA = '+16415550301';
const SAM = '+16415550302';
const GUEST = '+16415550303';
const SEVEN = [MEI, TOM, ADA, JORDAN, PRIYA, SAM, GUEST];

let db: TestDb;

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', KEY);
  vi.stubEnv('LINQ_FROM_E164', FROM);
  vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'true');
  vi.stubEnv('LINQ_GROUP_MEMBERS_ENABLED', 'true');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec(
    'truncate table linq_shared_group_people, linq_multi_family_joins, linq_multi_family_members, linq_multi_family_ledger, families, users cascade',
  );
});

function sender() {
  const texts: string[] = [];
  const send = async (notice: { chatId: string; text: string }) => {
    texts.push(notice.text);
    return { providerMessageId: `msg-${texts.length}` };
  };
  return { send, texts };
}

function listOf(handles: readonly string[]): ListChatHandles {
  return async () => ({ status: 'ok', handles: [...handles], isGroup: true });
}

function reading(
  intent: SharedGroupReading['intent'],
  extra: Partial<SharedGroupReading> = {},
): SharedGroupReader {
  return {
    async read() {
      return {
        intent,
        role: extra.role ?? 'unclear',
        familyLabel: extra.familyLabel ?? null,
        kidName: extra.kidName ?? null,
        confidence: extra.confidence ?? 'high',
      };
    },
  };
}

async function seedParent(phone: string, name: string, familyId?: string) {
  let home = familyId;
  if (!home) {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: name, provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    home = family?.id as string;
  }
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}-${phone}`, name })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId: home,
    userId,
    role: familyId ? 'co_parent' : 'primary_parent',
  });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId: home,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  return { familyId: home, userId, name, phone };
}

async function seedPrivate(familyId: string) {
  await db.database.insert(schema.children).values({
    familyId,
    name: CHILD,
    dateOfBirth: '2022-04-01',
  });
  await db.database.insert(schema.familyMemoryFacts).values({
    familyId,
    factType: 'preference',
    factKey: MEMORY,
    factValue: { note: 'hidden-memory' },
  });
  await db.database.insert(schema.familyEvents).values({
    familyId,
    title: CALENDAR,
    startsAt: NOW,
    source: 'parent',
  });
}

async function threeFamilies() {
  const mei = await seedParent(MEI, 'Mei');
  const tom = await seedParent(TOM, 'Tom', mei.familyId);
  const ada = await seedParent(ADA, 'Ada');
  const jordan = await seedParent(JORDAN, 'Jordan', ada.familyId);
  const priya = await seedParent(PRIYA, 'Priya');
  await seedPrivate(ada.familyId);
  return { mei, tom, ada, jordan, priya };
}

describe('multi-family zero-setup', () => {
  it('does nothing while the flag is off', async () => {
    vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'false');
    const home = await seedParent(MEI, 'Mei');
    const wire = sender();
    const joined = await joinFamilyToSharedGroup(db.database, {
      chatId: CHAT,
      familyId: home.familyId,
      userId: home.userId,
      phone: MEI,
      verbatim: 'count us in',
      now: NOW,
      send: wire.send,
    });
    expect(joined).toEqual({ outcome: 'flag_off' });
    expect(wire.texts).toEqual([]);
  });

  it('answers the first ask with no join phrase, links each known number to its own family, and joins nobody', async () => {
    const homes = await threeFamilies();
    const wire = sender();
    const voice = fakeSharedGroupComposer();
    const first = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: MEI,
        text: 'Hale, can you keep track of who is coming to Saturday swim?',
        providerMessageId: 'in-1',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      {
        listHandles: listOf(SEVEN),
        reader: reading('question'),
        composer: voice,
      },
    );
    expect(first).toMatchObject({ handled: true, outcome: 'shared_reply' });
    expect(wire.texts).toHaveLength(1);
    expect(wire.texts[0]).not.toContain('TODO-Design');
    expect(wire.texts[0]).not.toContain(CHILD);
    expect(wire.texts[0]).not.toContain(MEMORY);
    expect(wire.texts[0]).not.toContain(CALENDAR);

    expect(await db.database.select().from(schema.linqMultiFamilyJoins)).toEqual([]);

    const people = await db.database.select().from(schema.linqSharedGroupPeople);
    const byHash = new Map(people.map((row) => [row.phoneE164Hash, row]));
    expect(byHash.get(phoneBlindIndex(MEI))?.familyId).toBe(homes.mei.familyId);
    expect(byHash.get(phoneBlindIndex(TOM))?.familyId).toBe(homes.mei.familyId);
    expect(byHash.get(phoneBlindIndex(ADA))?.familyId).toBe(homes.ada.familyId);
    expect(byHash.get(phoneBlindIndex(PRIYA))?.familyId).toBe(homes.priya.familyId);
    expect(byHash.get(phoneBlindIndex(SAM))?.familyId).toBeNull();
    expect(byHash.get(phoneBlindIndex(GUEST))?.familyId).toBeNull();
  });

  it('seats the webhook handles before the gate when Linq cannot list the chat', async () => {
    const mei = await seedParent(MEI, 'Mei');
    const ada = await seedParent(ADA, 'Ada');
    const wire = sender();
    const first = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: MEI,
        otherHandles: [MEI, ADA],
        text: 'Hale, can you keep track of who is coming to Saturday swim?',
        providerMessageId: 'in-handles-1',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      { reader: reading('question'), composer: fakeSharedGroupComposer() },
    );
    expect(first).toMatchObject({ handled: true, outcome: 'shared_reply' });
    const people = await db.database.select().from(schema.linqSharedGroupPeople);
    const byHash = new Map(people.map((row) => [row.phoneE164Hash, row]));
    expect(byHash.get(phoneBlindIndex(MEI))?.familyId).toBe(mei.familyId);
    expect(byHash.get(phoneBlindIndex(ADA))?.familyId).toBe(ada.familyId);
  });

  it('stays quiet on banter and never merges two families', async () => {
    await threeFamilies();
    const wire = sender();
    const voice = fakeSharedGroupComposer();
    await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: MEI,
        text: 'Hale, Saturday swim — can you keep track?',
        providerMessageId: 'in-ask',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      { listHandles: listOf(SEVEN), reader: reading('question'), composer: voice },
    );
    const before = wire.texts.length;
    const banter = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: TOM,
        text: 'I can bring orange slices',
        providerMessageId: 'in-banter',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      { listHandles: listOf(SEVEN), reader: reading('chatter'), composer: voice },
    );
    // Chatter hands the turn back so the group door (text RSVP) still reads it.
    expect(banter).toEqual({ handled: false });
    expect(wire.texts).toHaveLength(before);

    const mei = (await db.database.select().from(schema.linqSharedGroupPeople)).find(
      (row) => row.phoneE164Hash === phoneBlindIndex(MEI),
    );
    const ada = (await db.database.select().from(schema.linqSharedGroupPeople)).find(
      (row) => row.phoneE164Hash === phoneBlindIndex(ADA),
    );
    expect(mei?.familyId).toBeTruthy();
    expect(ada?.familyId).toBeTruthy();
    expect(mei?.familyId).not.toBe(ada?.familyId);
  });

  for (const [label, intent, composer] of [
    ['an unclear read', 'unclear', () => fakeSharedGroupComposer()],
    ['a refused answer', 'question', () => fakeSharedGroupComposer({ decline: true })],
    ['a failed answer', 'question', () => fakeSharedGroupComposer({ fail: true })],
    ['a refused yes', 'yes', () => fakeSharedGroupComposer({ decline: true })],
  ] as const) {
    it(`hands the turn back on ${label} so text RSVP still reads it`, async () => {
      await threeFamilies();
      const wire = sender();
      await takeMultiFamilyTurn(
        db.database,
        {
          chatId: CHAT,
          senderHandle: MEI,
          text: 'Hale, Saturday swim — can you keep track?',
          providerMessageId: 'in-ask',
          receivedAt: NOW,
          now: NOW,
          send: wire.send,
        },
        {
          listHandles: listOf(SEVEN),
          reader: reading('question'),
          composer: fakeSharedGroupComposer(),
        },
      );
      const before = wire.texts.length;
      const out = await takeMultiFamilyTurn(
        db.database,
        {
          chatId: CHAT,
          senderHandle: TOM,
          text: 'we are in for saturday',
          providerMessageId: `in-${label}`,
          receivedAt: NOW,
          now: NOW,
          send: wire.send,
        },
        { listHandles: listOf(SEVEN), reader: reading(intent), composer: composer() },
      );
      expect(out).toEqual({ handled: false });
      expect(wire.texts).toHaveLength(before);
    });
  }

  it('unseats on a stop_me reading and leaves the others on Hale', async () => {
    await threeFamilies();
    const wire = sender();
    const voice = fakeSharedGroupComposer();
    await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: MEI,
        text: 'Hale, keep track of Saturday?',
        providerMessageId: 'in-ask',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      { listHandles: listOf(SEVEN), reader: reading('question'), composer: voice },
    );
    const stopped = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: JORDAN,
        text: 'I will bring the orange slices',
        providerMessageId: 'in-stop',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      {
        listHandles: listOf(SEVEN),
        reader: reading('stop_me'),
        composer: voice,
        optOut: async () => 'stop',
      },
    );
    expect(stopped).toMatchObject({ handled: true, outcome: 'member_stopped' });
    const jordan = (await db.database.select().from(schema.linqSharedGroupPeople)).find(
      (row) => row.phoneE164Hash === phoneBlindIndex(JORDAN),
    );
    expect(jordan?.stoppedAt).toEqual(NOW);
    const later = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: JORDAN,
        text: 'actually what time was swim',
        providerMessageId: 'in-after-stop',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      { listHandles: listOf(SEVEN), reader: reading('question'), composer: voice },
    );
    expect(later).toMatchObject({ handled: true, outcome: 'member_stopped' });
    const meiStill = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: MEI,
        text: 'Hale, how many are in?',
        providerMessageId: 'in-after-group',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      { listHandles: listOf(SEVEN), reader: reading('question'), composer: voice },
    );
    expect(meiStill).toMatchObject({ handled: true, outcome: 'shared_reply' });
  });

  it('reads a heart on Hale as a yes and never sends a poll card', async () => {
    await threeFamilies();
    const wire = sender();
    const voice = fakeSharedGroupComposer();
    await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: MEI,
        text: 'Hale, who is in for Saturday swim?',
        providerMessageId: 'in-ask',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      { listHandles: listOf(SEVEN), reader: reading('question'), composer: voice },
    );
    const yes = await takeMultiFamilyReaction(
      db.database,
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        reactionType: 'love',
        providerMessageId: 'in-heart',
        now: NOW,
      },
      { send: wire.send, listHandles: listOf(SEVEN), reader: reading('yes'), composer: voice },
    );
    expect(yes).toMatchObject({ handled: true, outcome: 'yes' });
    expect(wire.texts.join('\n')).not.toMatch(/poll|RSVP|button/i);
  });

  it('keeps each family private on the shared thread', async () => {
    const homes = await threeFamilies();
    const wire = sender();
    await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: MEI,
        text: 'Hale, Saturday swim?',
        providerMessageId: 'in-ask',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      {
        listHandles: listOf(SEVEN),
        reader: reading('question'),
        composer: fakeSharedGroupComposer(),
      },
    );
    const sqls: string[] = [];
    const real = db.client.query.bind(db.client);
    db.client.query = (async (text: string, ...rest: unknown[]) => {
      sqls.push(text);
      return real(text, ...(rest as never[]));
    }) as typeof db.client.query;
    const shared = await readFamilySliceForAudience(db.database, {
      chatId: CHAT,
      dataFamilyId: homes.ada.familyId,
      audience: 'shared_thread',
    });
    const other = await readFamilySliceForAudience(db.database, {
      chatId: CHAT,
      dataFamilyId: homes.ada.familyId,
      audience: homes.mei.familyId,
    });
    const seen = sqls.join('\n');
    expect(seen).not.toMatch(
      /children|family_memory_facts|family_events|email_forwards_pending|activity_bookings/,
    );
    db.client.query = real;
    expect(shared.slice.children).toEqual([]);
    expect(other.reason).toBe('other_family');
    const own = await readFamilySliceForAudience(db.database, {
      chatId: CHAT,
      dataFamilyId: homes.ada.familyId,
      audience: homes.ada.familyId,
    });
    expect(own.reason).toBe('present');
    expect(own.slice.children).toEqual([CHILD]);
    expect(shared.slice.calendar).toEqual([]);
    expect(other.slice.calendar).toEqual([]);
    expect(own.slice.calendar).toHaveLength(1);
    expect(own.slice.calendar[0]).toContain(CALENDAR);
    expect(own.slice.calendar[0]).toMatch(/\d{1,2}:\d{2}/);
  });

  it('introduces once when Hale is added, then a family can leave without a phrase', async () => {
    const homes = await threeFamilies();
    const wire = sender();
    const voice = fakeSharedGroupComposer();
    const intro = await noticeSharedGroupAdded(
      db.database,
      { chatId: CHAT, adderHandle: MEI, now: NOW, handles: SEVEN },
      { send: wire.send, listHandles: listOf(SEVEN), composer: voice },
    );
    expect(intro).toMatchObject({ handled: true, outcome: 'intro' });
    expect(wire.texts).toHaveLength(1);
    expect(voice.calls[0]?.input.kind).toBe('intro');

    await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        text: 'count us in',
        providerMessageId: 'in-join',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      { listHandles: listOf(SEVEN), reader: reading('join'), composer: voice },
    );
    const left = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: PRIYA,
        text: 'we are out of the carpool this season',
        providerMessageId: 'in-leave',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      { listHandles: listOf(SEVEN), reader: reading('leave'), composer: voice },
    );
    expect(left).toMatchObject({ handled: true, outcome: 'left' });
    const joins = await db.database
      .select({ leftAt: schema.linqMultiFamilyJoins.leftAt })
      .from(schema.linqMultiFamilyJoins)
      .where(eq(schema.linqMultiFamilyJoins.familyId, homes.priya.familyId));
    expect(joins[0]?.leftAt).toEqual(NOW);
  });

  it('unseats a removed member without dropping the family join', async () => {
    await threeFamilies();
    await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: MEI,
        text: 'count us in',
        providerMessageId: 'in-join',
        receivedAt: NOW,
        now: NOW,
        send: sender().send,
      },
      {
        listHandles: listOf(SEVEN),
        reader: reading('join'),
        composer: fakeSharedGroupComposer(),
      },
    );
    const removed = await unseatMultiFamilyMember(db.database, {
      chatId: CHAT,
      participantHandle: MEI,
      now: NOW,
    });
    expect(removed.outcome).toBe('linq_multi_family_unseated');
    const still = await db.database
      .select({ leftAt: schema.linqMultiFamilyJoins.leftAt })
      .from(schema.linqMultiFamilyJoins);
    expect(still).toHaveLength(1);
    expect(still.every((row) => row.leftAt == null)).toBe(true);
  });
});

describe('VIL-399: presence, not an auto-join', () => {
  async function multiFamilyConsents() {
    return db.database
      .select({
        familyId: schema.consentRecords.familyId,
        userId: schema.consentRecords.userId,
        granted: schema.consentRecords.granted,
        evidence: schema.consentRecords.evidence,
      })
      .from(schema.consentRecords)
      .where(eq(schema.consentRecords.consentType, 'multi_family_group'));
  }

  it('Hale being added writes no household consent and joins nobody', async () => {
    await threeFamilies();
    const wire = sender();
    const intro = await noticeSharedGroupAdded(
      db.database,
      { chatId: CHAT, adderHandle: MEI, now: NOW, handles: SEVEN },
      { send: wire.send, listHandles: listOf(SEVEN), composer: fakeSharedGroupComposer() },
    );
    // Positive control: the add itself was handled and Hale introduced itself.
    expect(intro).toMatchObject({ handled: true, outcome: 'intro' });
    expect(wire.texts).toHaveLength(1);
    expect(await multiFamilyConsents()).toEqual([]);
    expect(await db.database.select().from(schema.linqMultiFamilyJoins)).toEqual([]);
  });

  it("one parent's question writes no consent for any household", async () => {
    await threeFamilies();
    const wire = sender();
    const turn = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: MEI,
        text: 'what time is swim?',
        providerMessageId: 'in-question',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      {
        listHandles: listOf(SEVEN),
        reader: reading('question'),
        composer: fakeSharedGroupComposer(),
      },
    );
    expect(turn).toMatchObject({ handled: true, outcome: 'shared_reply' });
    expect(await multiFamilyConsents()).toEqual([]);
  });

  it("a parent's own join is that household's one consent, in their words", async () => {
    const homes = await threeFamilies();
    const wire = sender();
    const turn = await takeMultiFamilyTurn(
      db.database,
      {
        chatId: CHAT,
        senderHandle: MEI,
        text: 'count us in',
        providerMessageId: 'in-join',
        receivedAt: NOW,
        now: NOW,
        send: wire.send,
      },
      { listHandles: listOf(SEVEN), reader: reading('join'), composer: fakeSharedGroupComposer() },
    );
    expect(turn).toMatchObject({ handled: true, outcome: 'joined' });
    const consents = await multiFamilyConsents();
    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      familyId: homes.mei.familyId,
      userId: homes.mei.userId,
      granted: true,
      evidence: { verbatim: 'count us in' },
    });
    const joins = await db.database.select().from(schema.linqMultiFamilyJoins);
    expect(joins.map((row) => row.familyId)).toEqual([homes.mei.familyId]);
  });

  it('a household that is here but never joined is still deny-listed from the group line', async () => {
    await threeFamilies();
    const turn = (body: string, id: string, wire: ReturnType<typeof sender>) =>
      takeMultiFamilyTurn(
        db.database,
        {
          chatId: CHAT,
          senderHandle: MEI,
          text: 'who is coming Saturday?',
          providerMessageId: id,
          receivedAt: NOW,
          now: NOW,
          send: wire.send,
        },
        {
          listHandles: listOf(SEVEN),
          reader: reading('question'),
          composer: fakeSharedGroupComposer({ body }),
        },
      );

    const leakWire = sender();
    await turn(`${CHILD} is coming Saturday`, 'in-leak', leakWire);
    expect(leakWire.texts).toEqual([]);

    // Positive control: the same turn with a line that names no family's private term goes.
    const cleanWire = sender();
    await turn('see everyone Saturday', 'in-clean', cleanWire);
    expect(cleanWire.texts).toEqual(['see everyone Saturday']);
    expect(await db.database.select().from(schema.linqMultiFamilyJoins)).toEqual([]);
  });
});
