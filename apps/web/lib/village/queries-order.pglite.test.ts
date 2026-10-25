import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ActivityPick } from '~/lib/channel/activity/lane';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

vi.mock('~/lib/family', () => ({ currentFamilyId: vi.fn() }));
const discover = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('./discover', () => ({
  defaultDiscoverDeps: () => ({}),
  discoverForFamily: vi.fn(async () => ({
    status: 'discovered',
    insertedCount: 0,
    offeredIds: discover.ids,
  })),
}));

const { readVillage } = await import('./queries');
const { recordActivityOffers } = await import('./live');

let db: TestDb;
beforeAll(async () => {
  db = await createTestDb();
});
afterAll(async () => {
  await db.close();
});

const base: ActivityPick = {
  name: 'Museum art',
  sourceName: 'Museum',
  source: 'web',
  sourceUrl: 'https://museum.org/art',
  ageFit: 'ages 2-5',
  when: 'Saturdays',
  price: 'Free',
};

describe('readVillage', () => {
  it('VIL-451 · returns receipts in the live ranking order, not database order', async () => {
    const { familyId } = await seedFamily(db.database);
    const rows = await recordActivityOffers(db.database, familyId, [
      base,
      { ...base, name: 'Toddler swim', sourceUrl: 'https://pool.org/swim' },
      { ...base, name: 'Story time', sourceUrl: 'https://library.org/story' },
    ]);
    const ids = rows.map((row) => row.id);
    discover.ids = [ids[2], ids[0], ids[1]] as string[];
    const view = await readVillage(db.database, familyId);
    expect(view.candidates.map((candidate) => candidate.id)).toEqual(discover.ids);
  });
});
