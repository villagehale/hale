import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { CURATED_RESOURCES, type CuratedResourceSeed } from './curated-resources-data.js';
import { readCuratedResources, seedCuratedResources } from './curated-resources.js';

/**
 * Curated resources: an idempotent seed (upsert on the (name, area) unique index)
 * and a plain ordered read. No family scope, no teen redaction — public reference
 * data. We assert the seed's shape + conflict target (so a re-run never
 * duplicates), that it is a no-op for an empty list, and that the read maps rows
 * to the view in the order the DB returned.
 */

/** Captures the .insert().values(...).onConflictDoUpdate(...) chain. */
function fakeSeedDb() {
  const captured: {
    values?: unknown[];
    conflict?: { target: unknown; set: Record<string, unknown> };
  } = {};
  const onConflictDoUpdate = vi.fn().mockImplementation(async (arg) => {
    captured.conflict = arg;
  });
  const values = vi.fn().mockImplementation((rows: unknown[]) => {
    captured.values = rows;
    return { onConflictDoUpdate };
  });
  const insert = vi.fn().mockImplementation((table: unknown) => {
    if (table !== schema.curatedResources) throw new Error('unexpected insert target');
    return { values };
  });
  return { db: { insert } as never, captured, spies: { insert, values, onConflictDoUpdate } };
}

/** Captures the .select().from()[.where()].orderBy() read and returns the given
 * rows. `where` is present on the chain so an optional category filter can be
 * applied between from and orderBy. */
function fakeReadDb(rows: unknown[]) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where, orderBy });
  const select = vi.fn().mockReturnValue({ from });
  return { db: { select } as never, spies: { select, from, where, orderBy } };
}

const SAMPLE: CuratedResourceSeed[] = [
  {
    name: 'Halton Region – EarlyON',
    category: 'EarlyON child & family centres',
    area: 'Halton Region',
    url: 'https://www.halton.ca/earlyon',
    description: 'Free EarlyON programs, prenatal to 6.',
  },
  {
    name: 'Toronto Public Library – Kids',
    category: "Public library children's programs",
    area: 'Toronto',
    url: 'https://tpl.ca/kids',
    description: 'Storytimes and early literacy.',
  },
];

describe('seedCuratedResources', () => {
  it('upserts every entry with sortOrder = its index, conflicting on (name, area)', async () => {
    const { db, captured, spies } = fakeSeedDb();

    const result = await seedCuratedResources(db, SAMPLE);

    expect(result).toEqual({ count: 2 });
    // Each row carries the verified fields + a stable sortOrder = its index.
    expect(captured.values).toEqual([
      {
        name: 'Halton Region – EarlyON',
        category: 'EarlyON child & family centres',
        area: 'Halton Region',
        url: 'https://www.halton.ca/earlyon',
        description: 'Free EarlyON programs, prenatal to 6.',
        sortOrder: 0,
      },
      {
        name: 'Toronto Public Library – Kids',
        category: "Public library children's programs",
        area: 'Toronto',
        url: 'https://tpl.ca/kids',
        description: 'Storytimes and early literacy.',
        sortOrder: 1,
      },
    ]);
    // The conflict target is the (name, area) unique index — the idempotency key.
    expect(captured.conflict?.target).toEqual([
      schema.curatedResources.name,
      schema.curatedResources.area,
    ]);
    // A conflict UPDATES the mutable fields (so a re-run refreshes changed copy),
    // never inserts a duplicate.
    expect(Object.keys(captured.conflict?.set ?? {}).sort()).toEqual(
      ['category', 'description', 'sortOrder', 'url'].sort(),
    );
    expect(spies.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: two runs make the same upsert (never a second insert path)', async () => {
    const first = fakeSeedDb();
    const second = fakeSeedDb();

    await seedCuratedResources(first.db, SAMPLE);
    await seedCuratedResources(second.db, SAMPLE);

    // Both runs issue the identical upsert (same values, same conflict target) — the
    // DB's ON CONFLICT DO UPDATE makes the second run a no-op change, not a dupe.
    expect(second.captured.values).toEqual(first.captured.values);
    expect(second.captured.conflict?.target).toEqual(first.captured.conflict?.target);
  });

  it('is a no-op for an empty list (no insert issued)', async () => {
    const { db, spies } = fakeSeedDb();
    const result = await seedCuratedResources(db, []);
    expect(result).toEqual({ count: 0 });
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it('the shipped verified list is non-empty and every entry has a real https url', () => {
    expect(CURATED_RESOURCES.length).toBeGreaterThan(0);
    for (const entry of CURATED_RESOURCES) {
      expect(entry.url).toMatch(/^https:\/\//);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.area.length).toBeGreaterThan(0);
    }
    // No duplicate (name, area) pairs — the seed's idempotency key must be unique.
    const keys = CURATED_RESOURCES.map((e) => `${e.name}::${e.area}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('readCuratedResources', () => {
  it('maps rows to the view in the DB-returned order', async () => {
    const rows = [
      {
        id: 'r1',
        name: 'A',
        category: 'cat',
        area: 'Toronto',
        url: 'https://a.example',
        description: 'first',
        sortOrder: 0,
        createdAt: new Date(),
      },
      {
        id: 'r2',
        name: 'B',
        category: 'cat',
        area: 'Peel',
        url: 'https://b.example',
        description: 'second',
        sortOrder: 1,
        createdAt: new Date(),
      },
    ];
    const { db } = fakeReadDb(rows);

    const out = await readCuratedResources(db);

    expect(out).toEqual([
      { id: 'r1', name: 'A', category: 'cat', area: 'Toronto', url: 'https://a.example', description: 'first' },
      { id: 'r2', name: 'B', category: 'cat', area: 'Peel', url: 'https://b.example', description: 'second' },
    ]);
    // The view drops sortOrder + createdAt — the rail needs only the outward fields.
  });

  it('returns an empty list when there are no resources', async () => {
    const { db } = fakeReadDb([]);
    expect(await readCuratedResources(db)).toEqual([]);
  });

  it('applies no category filter when none is given (all rows, unchanged)', async () => {
    const { db, spies } = fakeReadDb([]);
    await readCuratedResources(db);
    expect(spies.where).not.toHaveBeenCalled();
  });

  it('filters by category server-side when a category is given', async () => {
    const rows = [
      {
        id: 'r1',
        name: 'EarlyON',
        category: 'EarlyON child & family centres',
        area: 'Halton Region',
        url: 'https://a.example',
        description: 'childcare',
        sortOrder: 0,
        createdAt: new Date(),
      },
    ];
    const { db, spies } = fakeReadDb(rows);

    const out = await readCuratedResources(db, 'EarlyON child & family centres');

    // The narrowing happens in SQL (a where clause), not in the caller.
    expect(spies.where).toHaveBeenCalledTimes(1);
    expect(out).toEqual([
      {
        id: 'r1',
        name: 'EarlyON',
        category: 'EarlyON child & family centres',
        area: 'Halton Region',
        url: 'https://a.example',
        description: 'childcare',
      },
    ]);
  });
});
