import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { writeFact } from './facts';
import {
  FALSE_CHILDREN_AGE_RANGE_ACTOR,
  FALSE_CHILDREN_AGE_RANGE_FACT_KEY,
  supersedeFalseChildrenAgeRange,
} from './supersede-false-children-age-range';

/**
 * The live row from 2026-10-01 is closed by valid_until, once. A second run
 * does not walk that instant forward, and it does not touch any other fact.
 */

const FAMILY_ID = '2c939172-0000-4000-8000-000000000001';
const OTHER_FAMILY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-10-01T14:00:00.000Z');
const LATER = new Date('2026-10-02T14:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function seedAgeRange(familyId: string) {
  return writeFact(db.database, {
    familyId,
    childId: null,
    factType: 'relationship',
    factKey: FALSE_CHILDREN_AGE_RANGE_FACT_KEY,
    factValue: {
      category: 'development',
      summary:
        'Children are 2-4 based on enrollment in Tiny Dancers and Parent & Tot Swimming starting Oct 3',
    },
    confidence: 0.95,
    inferredBy: 'chat_distiller',
    validFrom: new Date('2026-10-01T10:43:00.000Z'),
  });
}

async function fact(familyId: string, factKey: string) {
  const rows = await db.database
    .select()
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, familyId));
  const match = rows.find((candidate) => candidate.factKey === factKey);
  if (!match) throw new Error(`no ${factKey} for ${familyId}`);
  return match;
}

describe('supersedeFalseChildrenAgeRange', () => {
  it('closes the live children_age_range fact for the 2c939172 family and leaves every other fact live', async () => {
    await seedFamily(db.database, 'Incident family', FAMILY_ID);
    await seedFamily(db.database, 'Other family', OTHER_FAMILY_ID);
    const incident = await seedAgeRange(FAMILY_ID);
    await writeFact(db.database, {
      familyId: FAMILY_ID,
      childId: null,
      factType: 'routine',
      factKey: 'naps',
      factValue: { summary: 'Maya naps at 1' },
      confidence: 0.9,
      inferredBy: 'chat_distiller',
      validFrom: NOW,
    });
    const other = await seedAgeRange(OTHER_FAMILY_ID);

    const first = await supersedeFalseChildrenAgeRange(db.database, { now: NOW });

    expect(first).toMatchObject({ matched: 1, forgotten: 1, refused: 0 });
    const closed = await fact(FAMILY_ID, FALSE_CHILDREN_AGE_RANGE_FACT_KEY);
    expect(closed.id).toBe(incident.factId);
    expect(closed.validUntil).toEqual(NOW);
    expect(closed.supersededBy).toBeNull();
    expect((await fact(FAMILY_ID, 'naps')).validUntil).toBeNull();
    expect((await fact(OTHER_FAMILY_ID, FALSE_CHILDREN_AGE_RANGE_FACT_KEY)).id).toBe(other.factId);
    expect((await fact(OTHER_FAMILY_ID, FALSE_CHILDREN_AGE_RANGE_FACT_KEY)).validUntil).toBeNull();

    const audits = await db.database
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, FAMILY_ID));
    expect(audits).toContainEqual(
      expect.objectContaining({
        actor: FALSE_CHILDREN_AGE_RANGE_ACTOR,
        actionTaken: 'memory_fact_forgotten',
        targetId: incident.factId,
      }),
    );

    const second = await supersedeFalseChildrenAgeRange(db.database, { now: LATER });
    expect(second).toMatchObject({ matched: 0, forgotten: 0 });
    expect((await fact(FAMILY_ID, FALSE_CHILDREN_AGE_RANGE_FACT_KEY)).validUntil).toEqual(NOW);
  });
});
