import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { at } from '~/lib/testing/clock';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { groupChatKind, groupFamilyCount } from './groups';

describe('groupFamilyCount', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  it('is 1 for a household chat with no multi-family join rows', async () => {
    expect(await groupFamilyCount(db.database, 'chat-household')).toBe(1);
    expect(await groupFamilyCount(db.database, null)).toBe(1);
  });

  it('counts live joins so a two-family group is visible', async () => {
    const a = await seedFamily(db.database, 'A');
    const b = await seedFamily(db.database, 'B');
    const now = new Date();
    await db.database.insert(schema.linqMultiFamilyJoins).values([
      {
        chatId: 'chat-shared',
        familyId: a.familyId,
        joinedByUserId: a.parentUserId,
        joinedAt: now,
      },
      {
        chatId: 'chat-shared',
        familyId: b.familyId,
        joinedByUserId: b.parentUserId,
        joinedAt: now,
      },
    ]);
    expect(await groupFamilyCount(db.database, 'chat-shared')).toBe(2);
  });
});

/**
 * VIL-722 · the chat kind retention per channel splits on. It applies the multi-family
 * turn's own test, so a chat is multi-family exactly when Hale treats it as one.
 */
describe('groupChatKind', () => {
  let db: TestDb;
  const SEATED = at('2026-11-12T15:00:00.000Z');

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.close();
  });

  async function present(chatId: string, familyId: string | null, phoneHash: string) {
    await db.database.insert(schema.linqSharedGroupPeople).values({
      chatId,
      phoneE164Hash: phoneHash,
      familyId,
      seatedAt: SEATED,
    });
  }

  it('is a family group for a household chat with nobody else in it', async () => {
    const a = await seedFamily(db.database, 'A');
    expect(await groupChatKind(db.database, 'chat-household')).toBe('family_group');
    expect(await groupChatKind(db.database, null)).toBe('family_group');
    await present('chat-one', a.familyId, 'hash-a1');
    await present('chat-one', a.familyId, 'hash-a2');
    await present('chat-one', null, 'hash-guest');
    expect(await groupChatKind(db.database, 'chat-one')).toBe('family_group');
  });

  it('is multi-family once two households are present, joined or not', async () => {
    const a = await seedFamily(db.database, 'A');
    const b = await seedFamily(db.database, 'B');
    await present('chat-two', a.familyId, 'hash-a');
    await present('chat-two', b.familyId, 'hash-b');
    expect(await groupChatKind(db.database, 'chat-two')).toBe('multi_family_group');
    // Joins are a different count: family_count still says 1 here, and that is its rule.
    expect(await groupFamilyCount(db.database, 'chat-two')).toBe(1);
  });

  it('is multi-family on two live joins, and not on a join that left or never finished', async () => {
    const a = await seedFamily(db.database, 'A');
    const b = await seedFamily(db.database, 'B');
    const join = (familyId: string, over: { joinedAt?: Date | null; leftAt?: Date | null }) => ({
      chatId: 'chat-joined',
      familyId,
      joinedAt: SEATED,
      ...over,
    });
    await db.database
      .insert(schema.linqMultiFamilyJoins)
      .values([join(a.familyId, {}), join(b.familyId, { leftAt: SEATED })]);
    expect(await groupChatKind(db.database, 'chat-joined')).toBe('family_group');

    await db.database
      .insert(schema.linqMultiFamilyJoins)
      .values([join(b.familyId, { joinedAt: null })]);
    expect(await groupChatKind(db.database, 'chat-joined')).toBe('family_group');

    await db.database.insert(schema.linqMultiFamilyJoins).values([
      {
        chatId: 'chat-live',
        familyId: a.familyId,
        joinedAt: SEATED,
      },
      {
        chatId: 'chat-live',
        familyId: b.familyId,
        joinedAt: SEATED,
      },
    ]);
    expect(await groupChatKind(db.database, 'chat-live')).toBe('multi_family_group');
  });
});
