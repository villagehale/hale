import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  MULTI_FAMILY_JOINED_TEXT,
  MULTI_FAMILY_SHARED_REPLY,
  joinFamilyToSharedGroup,
  readFamilySliceForAudience,
  spendSharedGroupAsk,
  takeMultiFamilyTurn,
  unseatMultiFamilyMember,
} from './multi-family';

const KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_A = '+14165550111';
const PARENT_B = '+14165550222';
const FROM = '+16462352164';
const NOW = new Date('2026-10-02T15:00:00.000Z');
const CHAT = 'chat-shared-group';
const CHILD = 'Zephyrina';
const MEMORY = 'zephyr-memory-token';
const CALENDAR = 'zephyr-calendar-token';

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
  await db.exec('truncate table families, users cascade');
});

function sender() {
  const texts: string[] = [];
  const send = async (notice: { chatId: string; text: string }) => {
    texts.push(notice.text);
    return { providerMessageId: `msg-${texts.length}` };
  };
  return { send, texts };
}

async function seedFamily(phone: string, name: string) {
  const [family] = await db.database
    .insert(schema.families)
    .values({ displayName: name, provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `imessage:${name}`, name })
    .returning({ id: schema.users.id });
  const familyId = family?.id as string;
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({
    familyId,
    userId,
    role: 'primary_parent',
  });
  await db.database.insert(schema.parentChannels).values({
    userId,
    familyId,
    kind: 'sms',
    phoneE164Encrypted: encryptString(phone),
    phoneE164Hash: phoneBlindIndex(phone),
    verifiedAt: NOW,
  });
  return { familyId, userId };
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

describe('multi-family joins', () => {
  it('does nothing while the flag is off', async () => {
    vi.stubEnv('LINQ_MULTI_FAMILY_GROUPS_ENABLED', 'false');
    const home = await seedFamily(PARENT_A, 'Ada');
    const wire = sender();
    const joined = await joinFamilyToSharedGroup(db.database, {
      chatId: CHAT,
      familyId: home.familyId,
      userId: home.userId,
      phone: PARENT_A,
      verbatim: 'our family is in this group',
      now: NOW,
      send: wire.send,
    });
    expect(joined).toEqual({ outcome: 'flag_off' });
    expect(wire.texts).toEqual([]);
    const joins = await db.database.select().from(schema.linqMultiFamilyJoins);
    expect(joins).toEqual([]);
  });

  it('seats a family only after that family explicitly joins, and writes their consent', async () => {
    const ada = await seedFamily(PARENT_A, 'Ada');
    const bao = await seedFamily(PARENT_B, 'Bao');
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: CHAT })
      .where(eq(schema.families.id, ada.familyId));
    const wire = sender();

    const first = await takeMultiFamilyTurn(db.database, {
      chatId: CHAT,
      senderHandle: PARENT_A,
      text: 'our family is in this group',
      providerMessageId: 'in-1',
      receivedAt: NOW,
      now: NOW,
      send: wire.send,
    });
    expect(first).toMatchObject({ handled: true, outcome: 'joined' });
    expect(wire.texts).toEqual([MULTI_FAMILY_JOINED_TEXT]);

    const quiet = await takeMultiFamilyTurn(db.database, {
      chatId: CHAT,
      senderHandle: PARENT_B,
      text: 'hello from the other family',
      providerMessageId: 'in-2',
      receivedAt: NOW,
      now: NOW,
      send: wire.send,
    });
    expect(quiet.handled).toBe(false);

    const second = await takeMultiFamilyTurn(db.database, {
      chatId: CHAT,
      senderHandle: PARENT_B,
      text: 'notre famille est dans ce groupe',
      providerMessageId: 'in-3',
      receivedAt: NOW,
      now: NOW,
      send: wire.send,
    });
    expect(second).toMatchObject({ handled: true, outcome: 'joined' });

    const joins = await db.database.select().from(schema.linqMultiFamilyJoins);
    expect(joins.filter((row) => row.leftAt == null)).toHaveLength(2);
    const consents = await db.database
      .select({
        familyId: schema.consentRecords.familyId,
        granted: schema.consentRecords.granted,
        consentType: schema.consentRecords.consentType,
      })
      .from(schema.consentRecords);
    expect(consents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          familyId: ada.familyId,
          granted: true,
          consentType: 'multi_family_group',
        }),
        expect.objectContaining({
          familyId: bao.familyId,
          granted: true,
          consentType: 'multi_family_group',
        }),
      ]),
    );
  });

  it('keeps each family private and answers the shared thread from the placeholder only', async () => {
    const ada = await seedFamily(PARENT_A, 'Ada');
    const bao = await seedFamily(PARENT_B, 'Bao');
    await seedPrivate(bao.familyId);
    const wire = sender();
    await joinFamilyToSharedGroup(db.database, {
      chatId: CHAT,
      familyId: ada.familyId,
      userId: ada.userId,
      phone: PARENT_A,
      verbatim: 'our family is in this group',
      now: NOW,
      send: wire.send,
    });
    await joinFamilyToSharedGroup(db.database, {
      chatId: CHAT,
      familyId: bao.familyId,
      userId: bao.userId,
      phone: PARENT_B,
      verbatim: 'our family is in this group',
      now: NOW,
      send: wire.send,
    });

    const sqls: string[] = [];
    const real = db.client.query.bind(db.client);
    db.client.query = (async (text: string, ...rest: unknown[]) => {
      sqls.push(text);
      return real(text, ...(rest as never[]));
    }) as typeof db.client.query;
    const shared = await readFamilySliceForAudience(db.database, {
      chatId: CHAT,
      dataFamilyId: bao.familyId,
      audience: 'shared_thread',
    });
    const other = await readFamilySliceForAudience(db.database, {
      chatId: CHAT,
      dataFamilyId: bao.familyId,
      audience: ada.familyId,
    });
    const seen = sqls.join('\n');
    expect(seen).not.toMatch(
      /children|family_memory_facts|family_events|email_forwards_pending|activity_bookings/,
    );
    db.client.query = real;

    expect(shared.slice.children).toEqual([]);
    expect(shared.slice.memory).toEqual([]);
    expect(shared.slice.calendar).toEqual([]);
    expect(shared.slice.email).toEqual([]);
    expect(shared.slice.signups).toEqual([]);
    expect(other.reason).toBe('other_family');
    expect(other.slice.children).toEqual([]);

    const own = await readFamilySliceForAudience(db.database, {
      chatId: CHAT,
      dataFamilyId: bao.familyId,
      audience: bao.familyId,
    });
    expect(own.reason).toBe('consented');
    expect(own.slice.children).toEqual([CHILD]);
    expect(own.slice.memory).toEqual([MEMORY]);
    expect(own.slice.calendar).toEqual([]);

    const reply = await takeMultiFamilyTurn(db.database, {
      chatId: CHAT,
      senderHandle: PARENT_A,
      text: 'saturday at the park',
      providerMessageId: 'in-reply',
      receivedAt: NOW,
      now: NOW,
      send: wire.send,
    });
    expect(reply).toMatchObject({ handled: true, outcome: 'shared_reply' });
    expect(wire.texts.at(-1)).toBe(MULTI_FAMILY_SHARED_REPLY);
    const outbound = wire.texts.join('\n');
    expect(outbound).not.toContain(CHILD);
    expect(outbound).not.toContain(MEMORY);
    expect(outbound).not.toContain(CALENDAR);
    expect(outbound).not.toContain('hidden-memory');
  });

  it('asks and sends against the family that spent them', async () => {
    const ada = await seedFamily(PARENT_A, 'Ada');
    const bao = await seedFamily(PARENT_B, 'Bao');
    const wire = sender();
    await joinFamilyToSharedGroup(db.database, {
      chatId: CHAT,
      familyId: ada.familyId,
      userId: ada.userId,
      phone: PARENT_A,
      verbatim: 'our family is in this group',
      now: NOW,
      send: wire.send,
    });
    await joinFamilyToSharedGroup(db.database, {
      chatId: CHAT,
      familyId: bao.familyId,
      userId: bao.userId,
      phone: PARENT_B,
      verbatim: 'our family is in this group',
      now: NOW,
      send: wire.send,
    });

    const asked = await spendSharedGroupAsk(db.database, {
      chatId: CHAT,
      familyId: ada.familyId,
      parentUserId: ada.userId,
      now: NOW,
      send: wire.send,
    });
    expect(asked.outcome).toBe('asked');
    const again = await spendSharedGroupAsk(db.database, {
      chatId: CHAT,
      familyId: ada.familyId,
      parentUserId: ada.userId,
      now: NOW,
      send: wire.send,
    });
    expect(again).toEqual({ outcome: 'ask_budget' });
    const otherFamily = await spendSharedGroupAsk(db.database, {
      chatId: CHAT,
      familyId: bao.familyId,
      parentUserId: bao.userId,
      now: NOW,
      send: wire.send,
    });
    expect(otherFamily.outcome).toBe('asked');

    await db.database.insert(schema.linqMultiFamilyLedger).values(
      Array.from({ length: 3 }, () => ({
        chatId: CHAT,
        familyId: ada.familyId,
        kind: 'send' as const,
        createdAt: NOW,
      })),
    );
    const capped = await takeMultiFamilyTurn(db.database, {
      chatId: CHAT,
      senderHandle: PARENT_A,
      text: 'one more note',
      providerMessageId: 'in-cap',
      receivedAt: NOW,
      now: NOW,
      send: wire.send,
    });
    expect(capped).toMatchObject({ handled: true, outcome: 'family_send_cap' });
  });

  it('leaves the family and unseats a removed member without dropping the join', async () => {
    const ada = await seedFamily(PARENT_A, 'Ada');
    const wire = sender();
    await joinFamilyToSharedGroup(db.database, {
      chatId: CHAT,
      familyId: ada.familyId,
      userId: ada.userId,
      phone: PARENT_A,
      verbatim: 'our family is in this group',
      now: NOW,
      send: wire.send,
    });
    const removed = await unseatMultiFamilyMember(db.database, {
      chatId: CHAT,
      participantHandle: PARENT_A,
      now: NOW,
    });
    expect(removed.outcome).toBe('linq_multi_family_unseated');
    const still = await db.database
      .select({ leftAt: schema.linqMultiFamilyJoins.leftAt })
      .from(schema.linqMultiFamilyJoins);
    expect(still[0]?.leftAt).toBeNull();

    const left = await takeMultiFamilyTurn(db.database, {
      chatId: CHAT,
      senderHandle: PARENT_A,
      text: 'our family is leaving this group',
      providerMessageId: 'in-leave',
      receivedAt: NOW,
      now: NOW,
      send: wire.send,
    });
    expect(left).toMatchObject({ handled: true, outcome: 'left' });
    const joins = await db.database
      .select({ leftAt: schema.linqMultiFamilyJoins.leftAt })
      .from(schema.linqMultiFamilyJoins)
      .where(eq(schema.linqMultiFamilyJoins.familyId, ada.familyId));
    expect(joins[0]?.leftAt).toEqual(NOW);
    const withdrawn = await db.database
      .select({ granted: schema.consentRecords.granted })
      .from(schema.consentRecords);
    expect(withdrawn.some((row) => row.granted === false)).toBe(true);
    const after = await readFamilySliceForAudience(db.database, {
      chatId: CHAT,
      dataFamilyId: ada.familyId,
      audience: ada.familyId,
    });
    expect(after.reason).toBe('no_consent');
    expect(after.slice.children).toEqual([]);
  });
});
