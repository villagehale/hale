import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type SeededFamily, type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

/**
 * loadViewerSeats feeds the export gate on /trail and /messages. Over the real DDL it
 * returns every seat the viewer holds; in a credential-less preview (no DATABASE_URL)
 * it returns none without touching a database, as the other session reads do.
 */

const harness = vi.hoisted(() => ({ db: undefined as unknown as TestDb, userId: '' }));

vi.mock('~/auth', () => ({ auth: async () => null }));
vi.mock('~/lib/db', () => ({ db: () => harness.db.database }));
vi.mock('~/lib/family', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/lib/family')>()),
  currentUserId: async () => harness.userId,
}));

let home: SeededFamily;
let other: SeededFamily;

beforeAll(async () => {
  harness.db = await createTestDb();
  home = await seedFamily(harness.db.database, 'Home Family');
  other = await seedFamily(harness.db.database, 'Other Family');
  await harness.db.database
    .insert(schema.familyMembers)
    .values({ familyId: other.familyId, userId: home.parentUserId, role: 'nanny' });
  harness.userId = home.parentUserId;
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await harness.db.close();
});

describe('loadViewerSeats', () => {
  it('returns every seat the viewer holds', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://pglite.test/hale');
    const { loadViewerSeats } = await import('./queries');
    const seats = await loadViewerSeats();
    expect(seats).toHaveLength(2);
    expect(seats).toEqual(
      expect.arrayContaining([
        { familyId: home.familyId, role: 'primary_parent' },
        { familyId: other.familyId, role: 'nanny' },
      ]),
    );
  });

  it('returns no seats in a credential-less preview', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const { loadViewerSeats } = await import('./queries');
    expect(await loadViewerSeats()).toEqual([]);
  });
});
