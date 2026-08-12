import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedChild, seedFamily, type TestDb } from '~/lib/testing/pglite';
import { loadAgentContext } from './context';

/**
 * MEM-1 — which facts the coach is given.
 *
 * The select is capped at RELEVANT_FACT_LIMIT (30). Past that cap the cap itself
 * decides what Hale remembers, so the choice of WHICH 30 is a product decision,
 * not an implementation detail: unordered, Postgres may return any 30 rows and
 * heap order shifts on UPDATE, so the coach forgets different things on different
 * turns. These run against real Postgres because an ORDER BY is exactly what a
 * query-builder fake cannot check.
 */

const FACT_LIMIT = 30;

/** More facts than the cap, so the selection has to actually choose. */
const FACT_COUNT = 45;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

function load(familyId: string, focusedChildId: string | null) {
  return loadAgentContext(
    {
      familyId,
      question: 'what should I know?',
      intent: null,
      focusedChildId,
      transcript: [],
      sourceNote: null,
    },
    db.database,
  );
}

describe('coach context — ranking past the cap', () => {
  let familyId: string;

  beforeAll(async () => {
    ({ familyId } = await seedFamily(db.database, 'Ranking Family'));
    // Confidence ascends with the index, so the top-confidence facts are the ones
    // inserted LAST — i.e. exactly the rows an unordered `LIMIT 30` over heap
    // order drops first.
    await db.database.insert(schema.familyMemoryFacts).values(
      Array.from({ length: FACT_COUNT }, (_, i) => ({
        familyId,
        childId: null,
        factType: 'routine' as const,
        factKey: `family_fact_${i}`,
        factValue: { i },
        confidence: 0.5 + i / 100,
        validFrom: new Date(Date.UTC(2026, 0, 1 + i)),
      })),
    );
  });

  it('gives the coach the HIGHEST-confidence facts, not an arbitrary 30', async () => {
    const context = await load(familyId, null);

    expect(context.memoryFacts).toHaveLength(FACT_LIMIT);
    // The top 30 of 45 by confidence are indexes 44 down to 15.
    const expected = Array.from({ length: FACT_LIMIT }, (_, n) => `family_fact_${FACT_COUNT - 1 - n}`);
    expect(context.memoryFacts.map((f) => f.factKey)).toEqual(expected);
  });

  it('breaks a confidence + valid_from tie deterministically', async () => {
    // 1.0 is the column default, so ties at the top of the ranking are the common
    // case, not the exotic one. Two columns do not order tied rows — the third key
    // is what makes the sort total and the selection repeatable.
    const { familyId: tiedFamily } = await seedFamily(db.database, 'Tied Family');
    const validFrom = new Date(Date.UTC(2026, 0, 1));
    await db.database.insert(schema.familyMemoryFacts).values(
      Array.from({ length: FACT_COUNT }, (_, i) => ({
        familyId: tiedFamily,
        childId: null,
        factType: 'routine' as const,
        factKey: `tied_fact_${i}`,
        factValue: { i },
        confidence: 1,
        validFrom,
      })),
    );

    const first = await load(tiedFamily, null);
    await db.exec(
      `update family_memory_facts set fact_value = '{"touched": true}'
       where fact_key = 'tied_fact_0'`,
    );
    const second = await load(tiedFamily, null);

    expect(second.memoryFacts.map((f) => f.factKey)).toEqual(first.memoryFacts.map((f) => f.factKey));
  });
});

describe('coach context — focused-child scoping', () => {
  let familyId: string;
  let ellaId: string;

  beforeAll(async () => {
    ({ familyId } = await seedFamily(db.database, 'Scoping Family'));
    ellaId = await seedChild(db.database, familyId, 'Ella', 30);
    const noahId = await seedChild(db.database, familyId, 'Noah', 84);

    // Well under the cap, so the cap can never be what hides a row — scoping is
    // the only thing these assertions can be measuring.
    await db.database.insert(schema.familyMemoryFacts).values([
      {
        familyId,
        childId: null,
        factType: 'logistic' as const,
        factKey: 'home_city',
        factValue: { city: 'Toronto' },
        confidence: 0.9,
      },
      {
        familyId,
        childId: ellaId,
        factType: 'routine' as const,
        factKey: 'ella_naptime',
        factValue: { at: '13:00' },
        confidence: 0.8,
      },
      {
        familyId,
        childId: noahId,
        factType: 'routine' as const,
        factKey: 'noah_bedtime',
        factValue: { at: '20:00' },
        confidence: 0.99,
      },
    ]);
  });

  it("drops the sibling's facts and keeps the focused child's", async () => {
    const keys = (await load(familyId, ellaId)).memoryFacts.map((f) => f.factKey);

    expect(keys).toContain('ella_naptime');
    expect(keys).not.toContain('noah_bedtime');
  });

  it('keeps family-wide facts — focusing a child narrows, it does not blind', async () => {
    const keys = (await load(familyId, ellaId)).memoryFacts.map((f) => f.factKey);

    expect(keys).toContain('home_city');
  });

  it("ignores a focus id that is not one of this family's children", async () => {
    const stranger = '99999999-9999-4999-8999-999999999999';
    const keys = (await load(familyId, stranger)).memoryFacts.map((f) => f.factKey);

    // A focus that resolved to nobody falls back to the whole family, and hides nothing.
    expect(keys).toEqual(expect.arrayContaining(['home_city', 'ella_naptime', 'noah_bedtime']));
  });

  it('excludes superseded facts', async () => {
    await db.exec(
      `update family_memory_facts set valid_until = now() where fact_key = 'ella_naptime'`,
    );
    const keys = (await load(familyId, ellaId)).memoryFacts.map((f) => f.factKey);

    expect(keys).not.toContain('ella_naptime');
  });
});
