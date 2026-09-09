import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from './pglite';

/**
 * The CI pin: cloning a migrated snapshot must still be a real, isolated
 * Postgres — not a shared handle and not an empty WASM with no schema.
 *
 * Boots happen in the hook, not the test body: the first boot builds the
 * snapshot and exceeds the 5s test budget under CI load; hooks have their own.
 */
describe('createTestDb snapshot clone', () => {
  let db: TestDb;
  let a: TestDb;
  let b: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
    a = await createTestDb();
    b = await createTestDb();
  });
  afterAll(async () => {
    await Promise.all([db, a, b].map((clone) => clone.close()));
  });

  it('accepts writes on a cloned schema', async () => {
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Snapshot family', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    expect(family?.id).toBeTruthy();
  });

  it('does not leak rows from a sibling clone', async () => {
    await a.database
      .insert(schema.families)
      .values({ displayName: 'Only in A', provinceOrState: 'ON' });
    expect(await b.database.select().from(schema.families)).toEqual([]);
  });
});
