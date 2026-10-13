import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, migrationFiles, seedFamily } from '~/lib/testing/pglite';

const MIGRATION = '0165_proactive_cadence.sql';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

function candidate(familyId: string, parentUserId: string, dedupeKey: string) {
  return {
    familyId,
    parentUserId,
    kind: 'nudge',
    category: 'nudge' as const,
    templateKey: 'proactive_nudge:weather_swap',
    what: 'Indoor climbing at the river gym',
    why: 'weather_swap',
    dedupeKey,
  };
}

describe('0165 proactive_cadence', () => {
  it('is in the migration chain', () => {
    expect(migrationFiles()).toContain(MIGRATION);
  });

  it('holds one candidate per family and dedupe key, whatever its status', async () => {
    const family = await seedFamily(db.database);
    const [first] = await db.database
      .insert(schema.proactiveCandidates)
      .values(candidate(family.familyId, family.parentUserId, 'same-item'))
      .returning();
    expect(first?.status).toBe('queued');
    expect(first?.parentRequested).toBe(false);

    await db.database
      .update(schema.proactiveCandidates)
      .set({ status: 'sent' })
      .where(eq(schema.proactiveCandidates.id, first?.id ?? ''));
    await expect(
      db.database
        .insert(schema.proactiveCandidates)
        .values(candidate(family.familyId, family.parentUserId, 'same-item')),
    ).rejects.toThrow();

    const other = await seedFamily(db.database);
    await expect(
      db.database
        .insert(schema.proactiveCandidates)
        .values(candidate(other.familyId, other.parentUserId, 'same-item')),
    ).resolves.toBeDefined();
  });

  it('refuses a status outside the five the review writes', async () => {
    const family = await seedFamily(db.database);
    await expect(
      db.database.insert(schema.proactiveCandidates).values({
        ...candidate(family.familyId, family.parentUserId, 'bad-status'),
        status: 'maybe' as never,
      }),
    ).rejects.toThrow();
  });

  it('keeps one health row per sending line', async () => {
    await db.database
      .insert(schema.linqLineHealth)
      .values({ phoneNumber: 'line-a', status: 'flagged', paused: true });
    await expect(
      db.database
        .insert(schema.linqLineHealth)
        .values({ phoneNumber: 'line-a', status: 'active', paused: false }),
    ).rejects.toThrow();
  });

  it('cascades a family erasure to its candidates', async () => {
    const family = await seedFamily(db.database);
    await db.database
      .insert(schema.proactiveCandidates)
      .values(candidate(family.familyId, family.parentUserId, 'erased'));
    await db.database.delete(schema.families).where(eq(schema.families.id, family.familyId));
    const left = await db.database
      .select()
      .from(schema.proactiveCandidates)
      .where(eq(schema.proactiveCandidates.familyId, family.familyId));
    expect(left).toEqual([]);
  });

  it('applies a second time without throwing', async () => {
    await expect(db.applyMigration(MIGRATION)).resolves.toBeUndefined();
  });
});
