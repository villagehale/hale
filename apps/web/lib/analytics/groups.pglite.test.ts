import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { groupFamilyCount } from './groups';

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
