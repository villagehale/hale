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

/**
 * Chosen uuids, so `id ASC` is a known order and not a coin flip (see below). Every
 * row whose place a tiebreak decides gets one: with a random id, deleting a leg of the
 * ORDER BY leaves the outcome to chance and the test passes half the time.
 */
const ID_SMALLEST = '00000000-0000-4000-8000-00000000000a';
const ID_SMALL = '11111111-0000-4000-8000-00000000000b';
const ID_LARGE = 'eeeeeeee-0000-4000-8000-00000000000c';
const ID_LARGEST = 'ffffffff-0000-4000-8000-00000000000d';

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

/**
 * A live preference under a CHOSEN id, inserted directly.
 *
 * `writeFact` mints a random uuid, and a random uuid proves nothing about a tiebreak:
 * with a leg of the ORDER BY deleted the tied rows fall back to scan order, which a
 * random id matches about half the time — that is how the first version of this test
 * stayed green against the unordered query. These ids are picked so id order is the
 * reverse of both the insertion order and the fact_key the lookup index scans by.
 * Nothing is superseded here (every key is fresh), so skipping the write primitive
 * costs the test nothing.
 */
async function preferenceWithId(
  familyId: string,
  id: string,
  factKey: string,
  summary: string,
  confidence: number,
  validFrom: Date,
) {
  await db.database.insert(schema.familyMemoryFacts).values({
    id,
    familyId,
    childId: null,
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
    // Six live family-wide preferences for five slots, seeded so that every order the
    // database would fall into ON ITS OWN is wrong. `memory_facts_lookup_idx` is
    // (family_id, fact_type, fact_key) WHERE valid_until IS NULL, so a LIMIT 5 with no
    // ORDER BY comes back by fact_key — and the keys here run in the exact REVERSE of
    // the wanted rank, so that scan drops the strongest fact and keeps the weakest.
    // Insertion order is the same reverse, so a seq scan is wrong in the same way.
    // Each leg of the coach’s order (confidence DESC, valid_from DESC, id ASC) is the
    // only thing deciding one pair below, so deleting any one leg changes the answer.
    await preference(familyId, null, 'a', 'dropped', 0.7);
    await preferenceWithId(familyId, ID_LARGEST, 'b', 'tie-late-id', 0.85, SEPTEMBER);
    await preferenceWithId(familyId, ID_SMALLEST, 'c', 'tie-early-id', 0.85, SEPTEMBER);
    await preferenceWithId(familyId, ID_SMALL, 'd', 'conf-tie-earlier', 0.9, SEPTEMBER);
    await preferenceWithId(familyId, ID_LARGE, 'e', 'conf-tie-later', 0.9, OCTOBER);
    await preference(familyId, null, 'f', 'top', 1);

    const facts = await loadPlanFacts(db.database, familyId);

    expect(facts).toEqual([
      // confidence alone
      'top',
      // tied on confidence — valid_from breaks it
      'conf-tie-later',
      'conf-tie-earlier',
      // tied on confidence AND valid_from — id breaks it
      'tie-early-id',
      'tie-late-id',
    ]);
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
