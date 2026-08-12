import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestDb, seedChild, seedFamily, type TestDb } from '~/lib/testing/pglite';

/**
 * MEM-3 — "one live fact per key", enforced by Postgres rather than by five
 * writers each remembering to supersede.
 *
 * The migration has to survive contact with data that predates it: production
 * already holds duplicate live facts, written by the two paths that never
 * superseded at all. An index that can fail on existing rows is an outage, so the
 * repair and the constraint ship in the same file and are tested together — the
 * mess is seeded against the schema as it was BEFORE the migration, then the
 * migration is applied to it.
 */

const PREVIOUS_MIGRATION = '0083_village_intros.sql';
const MIGRATION = '0084_memory_fact_one_live_per_key.sql';

let db: TestDb;

afterEach(async () => {
  await db?.close();
});

/** A database at the schema version immediately before the migration under test. */
async function dbBeforeMigration() {
  db = await createTestDb(PREVIOUS_MIGRATION);
  return db;
}

async function factsFor(familyId: string) {
  return db.database
    .select()
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, familyId));
}

describe('migration 0084 — one live fact per key', () => {
  it('closes pre-existing duplicates, keeping the highest-confidence row', async () => {
    await dbBeforeMigration();
    const { familyId } = await seedFamily(db.database);
    await db.database.insert(schema.familyMemoryFacts).values([
      {
        familyId,
        childId: null,
        factType: 'routine',
        factKey: 'naptime',
        factValue: { at: '12:00' },
        confidence: 0.7,
        validFrom: new Date('2026-01-01T00:00:00Z'),
      },
      {
        familyId,
        childId: null,
        factType: 'routine',
        factKey: 'naptime',
        factValue: { at: '13:00' },
        confidence: 0.95,
        validFrom: new Date('2026-01-02T00:00:00Z'),
      },
      {
        familyId,
        childId: null,
        factType: 'routine',
        factKey: 'naptime',
        factValue: { at: '14:00' },
        confidence: 0.8,
        validFrom: new Date('2026-01-03T00:00:00Z'),
      },
    ]);

    await db.applyMigration(MIGRATION);

    const rows = await factsFor(familyId);
    const live = rows.filter((r) => r.validUntil === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.confidence).toBe(0.95);

    // The losers are not merely closed — they point at the row that won, so the
    // repair leaves a followable chain rather than an orphaned pair.
    const closed = rows.filter((r) => r.validUntil !== null);
    expect(closed).toHaveLength(2);
    for (const row of closed) {
      expect(row.supersededBy).toBe(live[0]?.id);
    }
  });

  it('breaks a confidence tie by recency, not arbitrarily', async () => {
    await dbBeforeMigration();
    const { familyId } = await seedFamily(db.database);
    await db.database.insert(schema.familyMemoryFacts).values([
      {
        familyId,
        childId: null,
        factType: 'preference',
        factKey: 'park',
        factValue: { name: 'older' },
        confidence: 1,
        validFrom: new Date('2026-01-01T00:00:00Z'),
      },
      {
        familyId,
        childId: null,
        factType: 'preference',
        factKey: 'park',
        factValue: { name: 'newer' },
        confidence: 1,
        validFrom: new Date('2026-02-01T00:00:00Z'),
      },
    ]);

    await db.applyMigration(MIGRATION);

    const live = (await factsFor(familyId)).filter((r) => r.validUntil === null);
    expect(live).toHaveLength(1);
    expect(live[0]?.factValue).toEqual({ name: 'newer' });
  });

  it('leaves rows that only LOOK like duplicates alone', async () => {
    await dbBeforeMigration();
    const { familyId } = await seedFamily(db.database);
    const ella = await seedChild(db.database, familyId, 'Ella', 30);
    const noah = await seedChild(db.database, familyId, 'Noah', 84);
    await db.database.insert(schema.familyMemoryFacts).values([
      // Same key, different children — two different truths, both still true.
      { familyId, childId: ella, factType: 'routine', factKey: 'bedtime', factValue: { at: '19:00' }, confidence: 1 },
      { familyId, childId: noah, factType: 'routine', factKey: 'bedtime', factValue: { at: '20:00' }, confidence: 1 },
      // Same key, already superseded — history, not a duplicate.
      {
        familyId,
        childId: null,
        factType: 'routine',
        factKey: 'dinner',
        factValue: { at: '17:00' },
        confidence: 1,
        validUntil: new Date('2026-01-01T00:00:00Z'),
      },
      { familyId, childId: null, factType: 'routine', factKey: 'dinner', factValue: { at: '18:00' }, confidence: 1 },
    ]);

    await db.applyMigration(MIGRATION);

    const live = (await factsFor(familyId)).filter((r) => r.validUntil === null);
    expect(live).toHaveLength(3);
  });

  it('refuses a second live fact on the same key from then on', async () => {
    await dbBeforeMigration();
    const { familyId } = await seedFamily(db.database);
    await db.applyMigration(MIGRATION);

    const row = {
      familyId,
      childId: null,
      factType: 'routine' as const,
      factKey: 'naptime',
      factValue: { at: '13:00' },
      confidence: 1,
    };
    await db.database.insert(schema.familyMemoryFacts).values(row);

    await expect(db.database.insert(schema.familyMemoryFacts).values(row)).rejects.toThrow(
      /memory_facts_one_live_per_key_idx/,
    );
  });

  it('still refuses a duplicate when the fact is family-wide (child_id NULL)', async () => {
    // Postgres treats NULLs as distinct in a unique index by default, which would
    // exempt every family-wide fact — the majority of them — from the constraint.
    await dbBeforeMigration();
    const { familyId } = await seedFamily(db.database);
    await db.applyMigration(MIGRATION);

    const result = (await db.exec(
      `select indnullsnotdistinct from pg_index
       where indexrelid = 'memory_facts_one_live_per_key_idx'::regclass`,
    )) as Array<{ rows: Array<{ indnullsnotdistinct: boolean }> }>;
    expect(result[0]?.rows[0]?.indnullsnotdistinct).toBe(true);

    const row = {
      familyId,
      childId: null,
      factType: 'logistic' as const,
      factKey: 'home_city',
      factValue: { city: 'Toronto' },
      confidence: 1,
    };
    await db.database.insert(schema.familyMemoryFacts).values(row);

    await expect(db.database.insert(schema.familyMemoryFacts).values(row)).rejects.toThrow();
  });
});
