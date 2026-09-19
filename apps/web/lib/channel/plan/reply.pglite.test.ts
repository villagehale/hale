import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeFact } from '~/lib/memory/facts';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { loadPlanFacts } from './reply';

/**
 * What the plan composer is allowed to be told about a household.
 *
 * `loadPlanFacts` is the only grounding input to a composed plan that reads the memory
 * table, and it had no coverage at all: `reply.test.ts` injects `loadFacts` as a fake,
 * so every defect in the real query was invisible to the suite that "tests the plan".
 * These run the real DDL, because two of the three obligations — one live row per
 * identity, and an ORDER BY that survives a LIMIT — are database facts a chain fake
 * cannot show.
 *
 * Every exclusion here is PAIRED with a positive control in the same test: an absence
 * assertion passes just as happily against a function that returns nothing at all.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

const SEPTEMBER = new Date('2026-09-01T12:00:00.000Z');
const OCTOBER = new Date('2026-10-01T12:00:00.000Z');

async function preference(
  familyId: string,
  childId: string | null,
  factKey: string,
  summary: string,
  confidence = 0.9,
  validFrom: Date = SEPTEMBER,
) {
  return writeFact(db.database, {
    familyId,
    childId,
    factType: 'preference',
    factKey,
    factValue: { summary },
    confidence,
    inferredBy: 'chat_distiller',
    validFrom,
  });
}

describe('loadPlanFacts', () => {
  let familyId: string;

  beforeEach(async () => {
    ({ familyId } = await seedFamily(db.database));
  });

  it('speaks only from what is still true — a superseded belief is gone, the live one stays', async () => {
    await preference(familyId, null, 'weekends', 'Weekends are for swimming.');
    // Same identity, later event time: `writeFact` closes the first row.
    await preference(familyId, null, 'weekends', 'Weekends are for skating.', 0.9, OCTOBER);
    await preference(familyId, null, 'mornings', 'Mornings are slow.');

    const facts = await loadPlanFacts(db.database, familyId);

    expect(facts).toContain('Weekends are for skating.');
    expect(facts).toContain('Mornings are slow.');
    expect(facts).not.toContain('Weekends are for swimming.');
  });

  it("never loads a child's own preference into a household plan, and still loads the house's", async () => {
    const teenId = await seedChild(db.database, familyId, 'Noa', 168);
    const toddlerId = await seedChild(db.database, familyId, 'Mia', 30);
    await preference(familyId, teenId, 'music', 'Noa only listens to metal.');
    await preference(familyId, toddlerId, 'food', 'Mia refuses broccoli.');
    await preference(familyId, null, 'dinner', 'The house eats at six.');

    const facts = await loadPlanFacts(db.database, familyId);

    expect(facts).toEqual(['The house eats at six.']);
  });

  it('when more facts are live than fit, keeps the ones the coach would already be seeing', async () => {
    // Six live family-wide preferences for five slots, written WEAKEST FIRST so an
    // unordered LIMIT 5 returns the wrong five. The coach's order is
    // confidence DESC, valid_from DESC, id ASC — so `dropped` is the row that loses.
    await preference(familyId, null, 'f', 'dropped', 0.75);
    await preference(familyId, null, 'e', 'low', 0.8);
    await preference(familyId, null, 'd', 'mid-early', 0.9, SEPTEMBER);
    await preference(familyId, null, 'c', 'mid-late', 0.9, OCTOBER);
    await preference(familyId, null, 'b', 'high', 0.95);
    await preference(familyId, null, 'a', 'top', 1);

    const facts = await loadPlanFacts(db.database, familyId);

    expect(facts).toEqual(['top', 'high', 'mid-late', 'mid-early', 'low']);
  });

  it('a household with nothing remembered grounds the plan on nothing, not on another family', async () => {
    const other = await seedFamily(db.database);
    await preference(other.familyId, null, 'dinner', 'The other house eats at five.');

    expect(await loadPlanFacts(db.database, familyId)).toEqual([]);
    expect(await loadPlanFacts(db.database, other.familyId)).toEqual([
      'The other house eats at five.',
    ]);
  });
});

describe('loadPlanFacts · the rows it reads', () => {
  it('reads the preference type only — a medical note is never plan grounding', async () => {
    const { familyId } = await seedFamily(db.database);
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'medical',
      factKey: 'allergy',
      factValue: { summary: 'Peanut allergy in the house.' },
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: SEPTEMBER,
    });
    await preference(familyId, null, 'dinner', 'The house eats at six.');

    const facts = await loadPlanFacts(db.database, familyId);

    expect(facts).toEqual(['The house eats at six.']);
    const rows = await db.database
      .select({ id: schema.familyMemoryFacts.id })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, familyId));
    expect(rows).toHaveLength(2);
  });
});
