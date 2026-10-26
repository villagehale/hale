import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';
import { dbThreadSummaryStore } from './thread-summary';

// Local pglite only: applies migration 0180 in the in-memory test DB.
let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

describe('conversation_summaries store (VIL-144, migration 0180)', () => {
  it('upserts per conversation and never reads across families', async () => {
    const { familyId } = await seedFamily(db.database, 'Summary Family');
    const { familyId: other } = await seedFamily(db.database, 'Other Family');
    const [conv] = await db.database
      .insert(schema.conversations)
      .values({ familyId })
      .returning({ id: schema.conversations.id });
    if (!conv) throw new Error('no conversation');
    const store = dbThreadSummaryStore(db.database);

    expect(await store.load(conv.id, familyId)).toBeNull();
    await store.save(conv.id, familyId, { summary: 'a', coveredTurns: 20 }, 'm');
    await store.save(conv.id, familyId, { summary: 'b', coveredTurns: 40 }, 'm');
    expect(await store.load(conv.id, familyId)).toEqual({ summary: 'b', coveredTurns: 40 });
    expect(await store.load(conv.id, other)).toBeNull();

    // A write keyed on the wrong family cannot overwrite this family's row.
    await store.save(conv.id, other, { summary: 'evil', coveredTurns: 99 }, 'm');
    expect(await store.load(conv.id, familyId)).toEqual({ summary: 'b', coveredTurns: 40 });
  });
});
