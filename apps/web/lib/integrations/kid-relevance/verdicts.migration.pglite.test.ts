import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type TestDb,
  createTestDb,
  migrationFiles,
  seedFamily,
  seedIntegration,
} from '~/lib/testing/pglite';

const MIGRATION = '0164_kid_relevance_verdicts.sql';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

function verdictRow(familyId: string, integrationId: string | null, itemKey: string) {
  return {
    familyId,
    source: 'google_calendar' as const,
    integrationId,
    itemKey,
    inputHash: 'h1',
    verdict: 'adult' as const,
    decidedBy: 'model' as const,
  };
}

describe('0164 kid_relevance_verdicts', () => {
  it('is in the migration chain', () => {
    expect(migrationFiles()).toContain(MIGRATION);
  });

  it('holds one verdict per item, null integration included', async () => {
    const family = await seedFamily(db.database);
    const integrationId = await seedIntegration(
      db.database,
      family.familyId,
      family.parentUserId,
      'gcal',
    );
    await db.database
      .insert(schema.kidRelevanceVerdicts)
      .values(verdictRow(family.familyId, integrationId, 'series-a'));
    await expect(
      db.database
        .insert(schema.kidRelevanceVerdicts)
        .values(verdictRow(family.familyId, integrationId, 'series-a')),
    ).rejects.toThrow();

    await db.database
      .insert(schema.kidRelevanceVerdicts)
      .values({ ...verdictRow(family.familyId, null, 'title-hash'), source: 'group' });
    await expect(
      db.database
        .insert(schema.kidRelevanceVerdicts)
        .values({ ...verdictRow(family.familyId, null, 'title-hash'), source: 'group' }),
    ).rejects.toThrow();

    const stored = await db.database
      .select()
      .from(schema.kidRelevanceVerdicts)
      .where(eq(schema.kidRelevanceVerdicts.familyId, family.familyId));
    expect(stored).toHaveLength(2);
  });

  it('refuses a stored reason on anything but a non-teen kid verdict', async () => {
    const family = await seedFamily(db.database);
    await expect(
      db.database.insert(schema.kidRelevanceVerdicts).values({
        ...verdictRow(family.familyId, null, 'adult-with-reason'),
        reason: 'a work meeting',
      }),
    ).rejects.toThrow();
    await expect(
      db.database.insert(schema.kidRelevanceVerdicts).values({
        ...verdictRow(family.familyId, null, 'teen-with-reason'),
        verdict: 'kid',
        teen: true,
        reason: 'practice',
      }),
    ).rejects.toThrow();
    const [kid] = await db.database
      .insert(schema.kidRelevanceVerdicts)
      .values({
        ...verdictRow(family.familyId, null, 'kid-with-reason'),
        verdict: 'kid',
        reason: 'a toddler swim class',
      })
      .returning();
    expect(kid?.reason).toBe('a toddler swim class');
  });

  it("keeps a hint only on a parent's own adult verdict", async () => {
    const family = await seedFamily(db.database);
    await expect(
      db.database.insert(schema.kidRelevanceVerdicts).values({
        ...verdictRow(family.familyId, null, 'model-with-hint'),
        hint: 'a hotel stay',
      }),
    ).rejects.toThrow();
    const [parent] = await db.database
      .insert(schema.kidRelevanceVerdicts)
      .values({
        ...verdictRow(family.familyId, null, 'parent-with-hint'),
        decidedBy: 'parent',
        hint: 'a hotel stay',
      })
      .returning();
    expect(parent?.hint).toBe('a hotel stay');
  });

  it('links a family event to its verdict and survives the verdict going away', async () => {
    const family = await seedFamily(db.database);
    const [verdict] = await db.database
      .insert(schema.kidRelevanceVerdicts)
      .values({ ...verdictRow(family.familyId, null, 'linked'), verdict: 'kid' })
      .returning({ id: schema.kidRelevanceVerdicts.id });
    if (!verdict) throw new Error('no verdict row');
    const [event] = await db.database
      .insert(schema.familyEvents)
      .values({
        familyId: family.familyId,
        title: 'Swim',
        startsAt: new Date('2026-10-20T15:00:00Z'),
        source: 'parent',
        kidVerdictId: verdict.id,
      })
      .returning();
    expect(event?.kidVerdictId).toBe(verdict.id);

    await db.database
      .delete(schema.kidRelevanceVerdicts)
      .where(eq(schema.kidRelevanceVerdicts.id, verdict.id));
    const [after] = await db.database
      .select()
      .from(schema.familyEvents)
      .where(eq(schema.familyEvents.id, event?.id ?? ''));
    expect(after?.kidVerdictId).toBeNull();
  });

  it('applies a second time without throwing', async () => {
    await expect(db.applyMigration(MIGRATION)).resolves.toBeUndefined();
  });
});
