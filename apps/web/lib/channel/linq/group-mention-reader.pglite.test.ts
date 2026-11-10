import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { phoneBlindIndex } from '~/lib/crypto/blind-index';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { listMentionableMembers, resolveGroupMention } from './group-mention-reader';

/**
 * VIL-475 — who a group reply may name. These tests use the real roster rows.
 * The reader is a stub: nothing calls a model.
 */

const KEY = Buffer.alloc(32, 7).toString('base64');
const HALE = '+14165550100';
const MINA = '+14165550111';
const CHAT = 'chat-family-group';
const DIRECT = 'chat-direct';

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
  vi.stubEnv('LINQ_FROM_E164', HALE);
  vi.stubEnv('LINQ_GROUP_MENTIONS_ENABLED', 'true');
  vi.stubEnv('VERCEL_ENV', 'preview');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  process.env.APP_ENCRYPTION_KEY = KEY;
  await db.exec('truncate table families, users cascade');
});

async function user(name: string, phone: string): Promise<string> {
  const [row] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${phoneBlindIndex(phone)}`, name })
    .returning({ id: schema.users.id });
  return row?.id as string;
}

async function family(): Promise<string> {
  const [row] = await db.database
    .insert(schema.families)
    .values({ displayName: 'Mina + kids', provinceOrState: 'ON' })
    .returning({ id: schema.families.id });
  return row?.id as string;
}

async function roster(chatId: string, status: 'confirmed' | 'not_group'): Promise<string> {
  const [row] = await db.database
    .insert(schema.linqGroupRosters)
    .values({ chatId, source: 'added_to_existing', status })
    .returning({ id: schema.linqGroupRosters.id });
  return row?.id as string;
}

async function knownParent(input: {
  rosterId: string;
  chatId: string;
  userId: string;
  phone: string;
}): Promise<string> {
  const [row] = await db.database
    .insert(schema.linqGroupRosterMembers)
    .values({
      rosterId: input.rosterId,
      chatId: input.chatId,
      phoneE164Encrypted: encryptString(input.phone),
      phoneE164Hash: phoneBlindIndex(input.phone),
      knownUserId: input.userId,
      status: 'known_parent',
    })
    .returning({ id: schema.linqGroupRosterMembers.id });
  return row?.id as string;
}

async function seat(input: {
  familyId: string;
  chatId: string;
  userId: string;
  phone: string;
}): Promise<string> {
  const [row] = await db.database
    .insert(schema.linqGroupMembers)
    .values({
      familyId: input.familyId,
      chatId: input.chatId,
      userId: input.userId,
      phoneE164Encrypted: encryptString(input.phone),
      phoneE164Hash: phoneBlindIndex(input.phone),
      role: 'parent',
      seatedAt: new Date('2026-10-28T18:00:00.000Z'),
    })
    .returning({ id: schema.linqGroupMembers.id });
  return row?.id as string;
}

describe('primary parent mention', () => {
  it('lists the roster known_parent once, and not Hale', async () => {
    const minaId = await user('Mina Shah', MINA);
    const haleId = await user('Hale Line', HALE);
    const familyId = await family();
    const rosterId = await roster(CHAT, 'confirmed');
    const knownId = await knownParent({
      rosterId,
      chatId: CHAT,
      userId: minaId,
      phone: MINA,
    });
    await knownParent({ rosterId, chatId: CHAT, userId: haleId, phone: HALE });
    const seatId = await seat({ familyId, chatId: CHAT, userId: minaId, phone: MINA });

    const members = await listMentionableMembers(db.database, CHAT);
    expect(members).toEqual([{ id: seatId, name: 'Mina', role: 'parent', handle: MINA }]);
    expect(members.some((member) => member.id === knownId)).toBe(false);
    expect(members.some((member) => member.handle === HALE)).toBe(false);

    const onlyRosterId = await roster('chat-known-only', 'confirmed');
    const onlyKnown = await knownParent({
      rosterId: onlyRosterId,
      chatId: 'chat-known-only',
      userId: minaId,
      phone: MINA,
    });
    expect(await listMentionableMembers(db.database, 'chat-known-only')).toEqual([
      { id: onlyKnown, name: 'Mina', role: 'parent', handle: MINA },
    ]);

    const reader = { read: vi.fn(async () => onlyKnown) };
    expect(
      await resolveGroupMention({
        database: db.database,
        chatId: 'chat-known-only',
        text: 'Swim is at 4.',
        reader,
      }),
    ).toBe(MINA);
    expect(reader.read).toHaveBeenCalledOnce();
  });
});

describe('resolveGroupMention group gate', () => {
  it('sends no mention when the chat has no roster row', async () => {
    const minaId = await user('Mina Shah', MINA);
    const familyId = await family();
    const seatId = await seat({ familyId, chatId: DIRECT, userId: minaId, phone: MINA });
    const reader = { read: vi.fn(async () => seatId) };
    expect(
      await resolveGroupMention({
        database: db.database,
        chatId: DIRECT,
        text: 'Swim is at 4.',
        reader,
      }),
    ).toBeUndefined();
    expect(reader.read).not.toHaveBeenCalled();
  });

  it('mentions a seated member when Linq says the chat is a group and no roster exists', async () => {
    const minaId = await user('Mina Shah', MINA);
    const familyId = await family();
    const seatId = await seat({ familyId, chatId: DIRECT, userId: minaId, phone: MINA });
    const reader = { read: vi.fn(async () => seatId) };
    expect(
      await resolveGroupMention({
        database: db.database,
        chatId: DIRECT,
        text: 'Swim is at 4.',
        reader,
        isGroup: true,
      }),
    ).toBe(MINA);
    expect(reader.read).toHaveBeenCalledOnce();
  });

  it('sends no mention when the roster says the chat is not a group', async () => {
    const minaId = await user('Mina Shah', MINA);
    const familyId = await family();
    const rosterId = await roster(DIRECT, 'not_group');
    await knownParent({ rosterId, chatId: DIRECT, userId: minaId, phone: MINA });
    const seatId = await seat({ familyId, chatId: DIRECT, userId: minaId, phone: MINA });
    const reader = { read: vi.fn(async () => seatId) };
    expect(
      await resolveGroupMention({
        database: db.database,
        chatId: DIRECT,
        text: 'Swim is at 4.',
        reader,
        isGroup: true,
      }),
    ).toBeUndefined();
    expect(reader.read).not.toHaveBeenCalled();
  });
});
