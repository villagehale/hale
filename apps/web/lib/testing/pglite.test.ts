import { schema } from '@hale/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDb } from './pglite';

/**
 * The CI pin: cloning a migrated snapshot must still be a real, isolated
 * Postgres — not a shared handle and not an empty WASM with no schema.
 */
describe('createTestDb snapshot clone', () => {
  const dbs: Array<{ close: () => Promise<void> }> = [];
  afterAll(async () => {
    await Promise.all(dbs.map((db) => db.close()));
  });

  it('accepts writes on a cloned schema', async () => {
    const db = await createTestDb();
    dbs.push(db);
    const [family] = await db.database
      .insert(schema.families)
      .values({ displayName: 'Snapshot family', provinceOrState: 'ON' })
      .returning({ id: schema.families.id });
    expect(family?.id).toBeTruthy();
  });

  it('does not leak rows from a sibling clone', async () => {
    const a = await createTestDb();
    const b = await createTestDb();
    dbs.push(a, b);
    await a.database
      .insert(schema.families)
      .values({ displayName: 'Only in A', provinceOrState: 'ON' });
    expect(await b.database.select().from(schema.families)).toEqual([]);
  });
});
