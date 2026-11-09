import { schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import { selectFamiliesForRun } from './families';

/**
 * VIL-597 G1. A capped nightly sweep must reach every family, not re-take the oldest
 * slice. 250 families under a cap of 100 is three runs.
 */

let db: TestDb;
const DAY_MS = 24 * 60 * 60 * 1000;
const START = new Date('2026-11-01T06:00:00.000Z');

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  await db.exec('truncate table families cascade');
});

async function seedFamilies(n: number): Promise<string[]> {
  const result = await db.database.execute(
    sql`insert into families (display_name, province_or_state, created_at)
        select 'Family ' || g, 'ON', ${START.toISOString()}::timestamptz - (g || ' minutes')::interval
        from generate_series(1, ${n}) as g returning id`,
  );
  const rows = (Array.isArray(result) ? result : (result as { rows: { id: string }[] }).rows) as {
    id: string;
  }[];
  return rows.map((row) => row.id);
}

describe('selectFamiliesForRun', () => {
  it('covers all 250 families in three capped runs', async () => {
    const all = await seedFamilies(250);
    const seen = new Set<string>();
    const sizes: number[] = [];
    for (let run = 0; run < 3; run += 1) {
      const ids = await selectFamiliesForRun(
        db.database,
        'inference',
        100,
        new Date(START.getTime() + run * DAY_MS),
      );
      sizes.push(ids.length);
      for (const id of ids) seen.add(id);
    }
    expect(sizes).toEqual([100, 100, 100]);
    expect(seen.size).toBe(250);
    expect([...seen].sort()).toEqual([...all].sort());
  });

  it('takes the families it has never taken first, then the longest ago', async () => {
    await seedFamilies(5);
    const first = await selectFamiliesForRun(db.database, 'inference', 3, START);
    const second = await selectFamiliesForRun(
      db.database,
      'inference',
      3,
      new Date(START.getTime() + DAY_MS),
    );
    // Two never taken, then the earliest of the first run.
    expect(second.slice(0, 2).some((id) => first.includes(id))).toBe(false);
    expect(second[2]).toBe(first[0]);
  });

  it('keeps each sweep on its own rotation', async () => {
    await seedFamilies(4);
    const inference = await selectFamiliesForRun(db.database, 'inference', 2, START);
    const digest = await selectFamiliesForRun(db.database, 'memory_digest', 2, START);
    // The digest has never run, so it starts from the same oldest pair.
    expect(digest).toEqual(inference);
    const marks = await db.database.select().from(schema.familySweepMarks);
    expect(marks).toHaveLength(4);
  });
});
