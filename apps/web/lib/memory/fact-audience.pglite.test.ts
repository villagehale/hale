import { schema } from '@hale/db';
import type { FactReader } from '@hale/worker/memory-context';
import { getMemorySlice } from '@hale/worker/memory-writer';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordWeekdayCare } from '~/lib/care/weekday';
import { productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import { departCoParent } from '~/lib/channel/coparent/depart';
import { loadPlanFacts } from '~/lib/channel/plan/reply';
import { loadAgentContext } from '~/lib/coach/context';
import { requestErasure } from '~/lib/rights/delete';
import { assembleFamilyExport } from '~/lib/rights/export';
import {
  type TestDb,
  createTestDb,
  seedChild,
  seedFamily,
  seedIntegration,
} from '~/lib/testing/pglite';
import { commitClassifiedMemory } from './classify-write';
import { type FactHeard, writeFact } from './facts';
import { handleParentMemory, recallFamilyMemory } from './store';
import { runFamilySynthesis } from './synthesis';

/**
 * VIL-599 · decision R7 in code: co-parents share logistics; anything else one adult said
 * in their own 1:1 stays with that adult. A fact records who said it, and every prompt
 * read is filtered by who it is read for. Each reader is checked with the other adult's
 * 1:1 fact (held back) and a control the reader must still get.
 */

const NOW = new Date('2026-11-08T15:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function seedCoParent(familyId: string): Promise<string> {
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `co-${familyId}@example.test`, name: 'Other Parent' })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('user insert returned no row');
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user.id, role: 'co_parent' });
  return user.id;
}

async function fact(
  familyId: string,
  factKey: string,
  heard: FactHeard,
  factType: 'preference' | 'logistic' = 'preference',
  sourceEventId?: string,
): Promise<void> {
  await writeFact(db.database, {
    familyId,
    childId: null,
    factType,
    factKey,
    factValue: { summary: `${factKey} words` },
    confidence: 0.9,
    inferredBy: 'ask-hale',
    heard,
    sourceEventId,
    validFrom: NOW,
  });
}

/** A: one parent. B: the co-parent. Each key names where it was said. */
async function seedHousehold() {
  const { familyId, parentUserId: a } = await seedFamily(db.database);
  const b = await seedCoParent(familyId);
  await seedIntegration(db.database, familyId, a, 'gmail');
  const [mail] = await db.database
    .insert(schema.events)
    .values({
      familyId,
      source: 'gmail',
      eventType: 'activity_signup_open',
      payload: { sender: 'Northside Rec <programs@rec.example>' },
      dedupHash: `mail-${familyId}`,
      receivedAt: NOW,
    })
    .returning({ id: schema.events.id });
  await fact(familyId, 'a_own', { in: 'one_to_one', userId: a });
  await fact(familyId, 'b_private', { in: 'one_to_one', userId: b });
  await fact(familyId, 'b_pickup', { in: 'one_to_one', userId: b }, 'logistic');
  await fact(familyId, 'group_said', { in: 'family', userId: b });
  // Legacy: inserted raw, as every row saved before the column existed.
  await db.database.insert(schema.familyMemoryFacts).values({
    familyId,
    factType: 'preference',
    factKey: 'legacy_pref',
    factValue: { summary: 'legacy_pref words' },
  });
  // Read in A's mailbox: only A may be told where it came from, so only A gets it.
  await fact(familyId, 'a_mailbox', { in: 'family', userId: null }, 'preference', mail?.id);
  return { familyId, a, b };
}

const A_SEES = ['a_mailbox', 'a_own', 'b_pickup', 'group_said'];
const B_SEES = ['b_pickup', 'b_private', 'group_said'];
const EVERY_ADULT_SEES = ['b_pickup', 'group_said'];

function coach(familyId: string, readerUserId: string, inGroup = false) {
  return loadAgentContext(
    {
      familyId,
      question: 'what is on this week?',
      intent: null,
      focusedChildId: null,
      transcript: [],
      sourceNote: null,
      readerUserId,
      inGroup,
    },
    db.database,
    NOW,
  );
}

describe('a fact records who said it', () => {
  it('a weekday-care answer in B’s 1:1 records B', async () => {
    const { familyId } = await seedFamily(db.database);
    const b = await seedCoParent(familyId);
    const childId = await seedChild(db.database, familyId, 'Kid', 30, undefined, NOW);
    await recordWeekdayCare(db.database, {
      familyId,
      parentUserId: b,
      childId,
      care: 'home',
      provider: null,
      now: NOW,
    });
    const [row] = await db.database
      .select({
        sourceUserId: schema.familyMemoryFacts.sourceUserId,
        sourceAudience: schema.familyMemoryFacts.sourceAudience,
      })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, familyId));
    expect(row).toEqual({ sourceUserId: b, sourceAudience: 'one_to_one' });
  });

  it('a correction texted in B’s 1:1 records B; one texted in the group is the family’s', async () => {
    const { familyId } = await seedFamily(db.database);
    const b = await seedCoParent(familyId);
    const correct = async (factKey: string, inGroup: boolean) => {
      const [inbound] = await db.database
        .insert(schema.channelMessages)
        .values({
          familyId,
          parentUserId: b,
          channel: 'imessage',
          direction: 'in',
          category: 'reply',
          status: 'delivered',
          inGroup,
        })
        .returning({ id: schema.channelMessages.id });
      await handleParentMemory(db.database, {
        familyId,
        parentUserId: b,
        body: `correct ${factKey}: not for us`,
        now: NOW,
        inboundChannelMessageId: inbound?.id ?? null,
        env: { FAMILY_MEMORY_KINDS_ENABLED: 'true' },
        replyClient: null,
      });
      const [row] = await db.database
        .select({
          sourceUserId: schema.familyMemoryFacts.sourceUserId,
          sourceAudience: schema.familyMemoryFacts.sourceAudience,
        })
        .from(schema.familyMemoryFacts)
        .where(
          and(
            eq(schema.familyMemoryFacts.familyId, familyId),
            eq(schema.familyMemoryFacts.factKey, factKey),
            isNull(schema.familyMemoryFacts.validUntil),
          ),
        );
      return row;
    };
    expect(await correct('swimming', false)).toEqual({
      sourceUserId: b,
      sourceAudience: 'one_to_one',
    });
    expect(await correct('skating', true)).toEqual({ sourceUserId: b, sourceAudience: 'family' });
  });
});

describe('every prompt read is filtered by who it is for (R7)', () => {
  it('ranking: the find slice', async () => {
    const { familyId, a, b } = await seedHousehold();
    const fit = productionActivityFamilyReader().familyFit;
    const keys = async (reader: Parameters<NonNullable<typeof fit>>[2]) =>
      ((await fit?.(db.database, familyId, reader, NOW))?.preferences ?? [])
        .map((p) => p.key)
        .sort();
    expect(await keys({ adult: a })).toEqual(A_SEES);
    expect(await keys({ adult: b })).toEqual(B_SEES);
    expect(await keys('every_adult')).toEqual(EVERY_ADULT_SEES);
  });

  it('plan facts', async () => {
    const { familyId, a, b } = await seedHousehold();
    const plan = async (reader: { adult: string }) =>
      (await loadPlanFacts(db.database, familyId, reader, NOW)).sort();
    // Plan facts are preferences only, so the logistic pickup is not one of them.
    expect(await plan({ adult: a })).toEqual(
      ['a_mailbox', 'a_own', 'group_said'].map((key) => `${key} words`),
    );
    expect(await plan({ adult: b })).toEqual(
      ['b_private', 'group_said'].map((key) => `${key} words`),
    );
  });

  it('the digest drafter reads what every adult may hear', async () => {
    const { familyId } = await seedHousehold();
    const slice = await getMemorySlice(familyId, db.database, NOW);
    expect(slice.facts.map((f) => f.factKey).sort()).toEqual(EVERY_ADULT_SEES);
  });

  it("A's coach context holds nothing from B's 1:1 but the shared logistics", async () => {
    const { familyId, a, b } = await seedHousehold();
    const forA = await coach(familyId, a);
    expect(forA.memoryFacts.map((f) => f.factKey).sort()).toEqual(A_SEES);
    expect(JSON.stringify(forA)).not.toContain('b_private');
    expect(forA.memoryBrief.text).toContain('b_pickup');
    const forB = await coach(familyId, b);
    expect(forB.memoryFacts.map((f) => f.factKey).sort()).toEqual(B_SEES);
    expect(forB.memoryBrief.text).toContain('b_private');
    // In the family group every adult hears the reply, so neither adult's 1:1 rides.
    const inGroup = await coach(familyId, a, true);
    expect(inGroup.memoryFacts.map((f) => f.factKey).sort()).toEqual(EVERY_ADULT_SEES);
    expect(inGroup.memoryBrief.text).not.toContain('a_own');
  });

  it('a row saved before the speaker was kept is held back while another adult is on record', async () => {
    const { familyId, a } = await seedHousehold();
    const [legacy] = await db.database
      .select({
        sourceAudience: schema.familyMemoryFacts.sourceAudience,
        sourceUserId: schema.familyMemoryFacts.sourceUserId,
      })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, familyId),
          eq(schema.familyMemoryFacts.factKey, 'legacy_pref'),
        ),
      );
    expect(legacy).toEqual({ sourceAudience: 'unrecorded', sourceUserId: null });
    expect((await coach(familyId, a)).memoryFacts.map((f) => f.factKey)).not.toContain(
      'legacy_pref',
    );

    // Control: with one adult on record there is no other adult to hold it from.
    const solo = await seedFamily(db.database);
    await db.database.insert(schema.familyMemoryFacts).values({
      familyId: solo.familyId,
      factType: 'preference',
      factKey: 'legacy_pref',
      factValue: { summary: 'legacy_pref words' },
    });
    expect(
      (await coach(solo.familyId, solo.parentUserId)).memoryFacts.map((f) => f.factKey),
    ).toEqual(['legacy_pref']);
  });
});

describe('the right-to-access copy reads the same rule', () => {
  it("returns the requester's own facts and holds back the other adult's", async () => {
    const { familyId, a } = await seedHousehold();
    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: a,
      loadTrail: async () => [],
      now: NOW,
    });
    expect(doc.memory.facts.map((f) => [f.factKey, f.withheld])).toEqual([
      ['a_own', null],
      [null, 'another_adult'],
      ['b_pickup', null],
      ['group_said', null],
      [null, 'source_not_recorded'],
      ['a_mailbox', null],
    ]);
    expect(JSON.stringify(doc.memory)).not.toContain('b_private');
    expect(JSON.stringify(doc.memory)).not.toContain('legacy_pref');
  });
});

async function inboundFrom(familyId: string, parentUserId: string): Promise<string> {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      inGroup: false,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('inbound insert returned no row');
  return row.id;
}

async function texted(familyId: string, parentUserId: string, body: string) {
  return handleParentMemory(db.database, {
    familyId,
    parentUserId,
    body,
    now: NOW,
    inboundChannelMessageId: await inboundFrom(familyId, parentUserId),
    env: { FAMILY_MEMORY_KINDS_ENABLED: 'true' },
    replyClient: null,
  });
}

async function live(familyId: string, factKey: string) {
  return db.database
    .select({
      factValue: schema.familyMemoryFacts.factValue,
      sourceUserId: schema.familyMemoryFacts.sourceUserId,
    })
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        eq(schema.familyMemoryFacts.factKey, factKey),
        isNull(schema.familyMemoryFacts.validUntil),
      ),
    );
}

describe('a forget or a correction touches only what the sender may hear (R7)', () => {
  it('A’s forget in A’s 1:1 leaves B’s 1:1 fact live; A’s own and a heard-by-both fact go', async () => {
    const { familyId, a, b } = await seedHousehold();
    await fact(familyId, 'swimming', { in: 'one_to_one', userId: b });
    await fact(familyId, 'skating', { in: 'one_to_one', userId: a });
    await fact(familyId, 'piano', { in: 'family', userId: b });
    await fact(familyId, 'violin', { in: 'family', userId: a });

    const held = await texted(familyId, a, 'forget swimming');
    expect([held.outcome, held.forgotten, held.groupSync.skipped]).toEqual([
      'nothing',
      0,
      'nothing_to_sync',
    ]);
    expect(await live(familyId, 'swimming')).toHaveLength(1);

    expect((await texted(familyId, a, 'forget skating')).forgotten).toBe(1);
    expect(await live(familyId, 'skating')).toHaveLength(0);
    expect((await texted(familyId, a, 'forget piano')).forgotten).toBe(1);
    expect(await live(familyId, 'piano')).toHaveLength(0);
    expect((await texted(familyId, b, 'forget violin')).forgotten).toBe(1);
    expect(await live(familyId, 'violin')).toHaveLength(0);
  });

  it('A’s correction of A’s own fact supersedes it; of a group-said one, leaves the household’s live for B', async () => {
    const { familyId, a, b } = await seedHousehold();
    await fact(familyId, 'skating', { in: 'one_to_one', userId: a });
    await fact(familyId, 'piano', { in: 'family', userId: b });

    // Control: A's own fact is in A's scope, so the correction supersedes it.
    expect((await texted(familyId, a, 'correct skating: tuesdays')).corrected).toBe(1);
    expect(await live(familyId, 'skating')).toEqual([{ factValue: 'tuesdays', sourceUserId: a }]);

    // A write closes only rows in its own scope: A's word lands in A's scope and the
    // household's row stays live, so B keeps the value and nothing is lost across adults.
    expect((await texted(familyId, a, 'correct piano: tuesdays')).corrected).toBe(1);
    const piano = await live(familyId, 'piano');
    expect(piano).toHaveLength(2);
    expect(piano).toContainEqual({ factValue: 'tuesdays', sourceUserId: a });
    expect(piano).toContainEqual({ factValue: { summary: 'piano words' }, sourceUserId: b });
    const coached = async (reader: string, inGroup = false) =>
      (await coach(familyId, reader, inGroup)).memoryFacts
        .filter((f) => f.factKey === 'piano')
        .map((f) => f.factValue);
    expect(await coached(a)).toEqual(['tuesdays']);
    expect(await coached(b)).toEqual([{ summary: 'piano words' }]);
    expect(await coached(a, true)).toEqual([{ summary: 'piano words' }]);
  });

  it('a correction retires an unrecorded row only while one adult is on record', async () => {
    // Two adults: the unrecorded row is held back from both, so A's correction cannot
    // see it and leaves it live.
    const { familyId, a } = await seedHousehold();
    expect((await texted(familyId, a, 'correct legacy_pref: tuesdays')).corrected).toBe(1);
    const shared = await live(familyId, 'legacy_pref');
    expect(shared).toHaveLength(2);
    expect(shared).toContainEqual({
      factValue: { summary: 'legacy_pref words' },
      sourceUserId: null,
    });
    // Control: alone on record, the adult's correction retires the unrecorded guess.
    const solo = await seedFamily(db.database);
    await fact(solo.familyId, 'legacy_pref', 'unrecorded');
    expect(
      (await texted(solo.familyId, solo.parentUserId, 'correct legacy_pref: tuesdays')).corrected,
    ).toBe(1);
    expect(await live(solo.familyId, 'legacy_pref')).toEqual([
      { factValue: 'tuesdays', sourceUserId: solo.parentUserId },
    ]);
  });

  it('in A’s 1:1, A’s own private row over the household’s on one key reads as the newer', async () => {
    const { familyId, a, b } = await seedHousehold();
    await fact(familyId, 'piano', { in: 'family', userId: b });
    // A save in A's 1:1 (not a correction) lands in A's scope beside the household row.
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'piano',
      factValue: 'tuesdays',
      confidence: 0.9,
      inferredBy: 'ask-hale',
      heard: { in: 'one_to_one', userId: a },
      validFrom: new Date(NOW.getTime() + 60_000),
    });
    expect(await live(familyId, 'piano')).toHaveLength(2);
    const value = async (reader: FactReader) =>
      (await recallFamilyMemory(db.database, { familyId, now: NOW, reader }))
        .filter((f) => f.factKey === 'piano')
        .map((f) => f.factValue);
    const coached = async (reader: string, inGroup = false) =>
      (await coach(familyId, reader, inGroup)).memoryFacts
        .filter((f) => f.factKey === 'piano')
        .map((f) => f.factValue);
    expect(await value({ adult: a })).toEqual(['tuesdays']);
    expect(await coached(a)).toEqual(['tuesdays']);
    // Control: B and the group read the household row.
    expect(await value({ adult: b })).toEqual([{ summary: 'piano words' }]);
    expect(await coached(b)).toEqual([{ summary: 'piano words' }]);
    expect(await coached(a, true)).toEqual([{ summary: 'piano words' }]);
  });
});

/**
 * One live row per identity used to mean A's private fact and B's private fact on one key
 * could not both be live, so every write either overwrote the other adult's fact or
 * refused in a way that showed it was there. A private fact's identity now names its
 * speaker (`memory_facts_one_live_per_scope_idx`).
 */
describe("a fact's live identity includes whose private fact it is", () => {
  it('A’s correction on a key only B’s 1:1 fact holds reads exactly as one on an empty key', async () => {
    const hidden = await seedHousehold();
    await fact(hidden.familyId, 'swimming', { in: 'one_to_one', userId: hidden.b });
    const empty = await seedHousehold();

    const onHidden = await texted(hidden.familyId, hidden.a, 'correct swimming: tuesdays');
    const onEmpty = await texted(empty.familyId, empty.a, 'correct swimming: tuesdays');
    // Positive control: the empty key is corrected and answered, so equality says something.
    expect([onEmpty.outcome, onEmpty.corrected]).toEqual(['corrected', 1]);
    // The reply is the model's, written from (outcome, key, value) alone; with no model
    // configured both are null, and the whole result, group sync included, must match.
    expect(onHidden).toEqual(onEmpty);

    const rows = await live(hidden.familyId, 'swimming');
    expect(rows).toHaveLength(2);
    expect(rows).toContainEqual({
      factValue: { summary: 'swimming words' },
      sourceUserId: hidden.b,
    });
    expect(rows).toContainEqual({ factValue: 'tuesdays', sourceUserId: hidden.a });
  });

  it('afterwards each adult’s 1:1 reads their own value, and the group reads neither', async () => {
    const { familyId, a, b } = await seedHousehold();
    await fact(familyId, 'swimming', { in: 'one_to_one', userId: b });
    await texted(familyId, a, 'correct swimming: tuesdays');

    const swimming = (facts: { factKey: string; factValue: unknown }[]) =>
      facts.filter((f) => f.factKey === 'swimming').map((f) => f.factValue);
    expect(swimming((await coach(familyId, a)).memoryFacts)).toEqual(['tuesdays']);
    expect(swimming((await coach(familyId, b)).memoryFacts)).toEqual([
      { summary: 'swimming words' },
    ]);
    expect(
      swimming(await recallFamilyMemory(db.database, { familyId, now: NOW, reader: { adult: a } })),
    ).toEqual(['tuesdays']);
    expect(
      swimming(await recallFamilyMemory(db.database, { familyId, now: NOW, reader: { adult: b } })),
    ).toEqual([{ summary: 'swimming words' }]);

    const group = await coach(familyId, a, true);
    expect(swimming(group.memoryFacts)).toEqual([]);
    expect(JSON.stringify(group)).not.toContain('tuesdays');
    // Control: the group read is not empty; it carries what every adult heard.
    expect(group.memoryFacts.map((f) => f.factKey).sort()).toEqual(EVERY_ADULT_SEES);
  });

  it('a write by one adult never closes the other adult’s private fact', async () => {
    const { familyId, a, b } = await seedHousehold();
    await fact(familyId, 'nap', { in: 'one_to_one', userId: b });
    await fact(familyId, 'nap', { in: 'one_to_one', userId: a });
    expect((await live(familyId, 'nap')).map((r) => r.sourceUserId).sort()).toEqual([a, b].sort());

    // Control: A's second write supersedes A's first, and B's is still there.
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'nap',
      factValue: 'later',
      confidence: 0.9,
      inferredBy: 'ask-hale',
      heard: { in: 'one_to_one', userId: a },
      validFrom: NOW,
    });
    const nap = await live(familyId, 'nap');
    expect(nap).toHaveLength(2);
    expect(nap).toContainEqual({ factValue: 'later', sourceUserId: a });
    expect(nap).toContainEqual({ factValue: { summary: 'nap words' }, sourceUserId: b });
  });

  it('a logistic said in a 1:1 is the household’s: it keeps one live row', async () => {
    const { familyId, a, b } = await seedHousehold();
    await fact(familyId, 'pickup', { in: 'one_to_one', userId: b }, 'logistic');
    await fact(familyId, 'pickup', { in: 'one_to_one', userId: a }, 'logistic');
    expect(await live(familyId, 'pickup')).toEqual([
      { factValue: { summary: 'pickup words' }, sourceUserId: a },
    ]);
  });

  it('the nightly writer never closes a 1:1 fact, by key or by a correction', async () => {
    const { familyId, a, b } = await seedHousehold();
    await fact(familyId, 'bedtime', { in: 'one_to_one', userId: a });
    await fact(familyId, 'bedtime', { in: 'one_to_one', userId: b });
    await fact(familyId, 'bath', { in: 'one_to_one', userId: a });
    await fact(familyId, 'bath', 'unrecorded');
    const nightly = (factKey: string, correctsKey: string | null) =>
      commitClassifiedMemory(db.database, {
        familyId,
        childId: null,
        factType: 'preference',
        factKey,
        factValue: `${factKey} nightly`,
        confidence: 0.9,
        inferredBy: 'chat_distiller',
        source: 'inferred',
        now: NOW,
        memoryClass: 'enduring',
        disposition: 'confirmed',
        correctsKey,
        heard: 'unrecorded',
      });

    await nightly('bedtime', null);
    expect((await live(familyId, 'bedtime')).map((r) => r.sourceUserId).sort()).toEqual(
      [a, b, null].sort(),
    );
    // A correction onto another key closes the unrecorded row it names (control), and
    // leaves A's own row on that key live.
    await nightly('bath_time', 'bath');
    expect(await live(familyId, 'bath')).toEqual([
      { factValue: { summary: 'bath words' }, sourceUserId: a },
    ]);
    // Control: a second nightly write supersedes the first unrecorded one.
    await nightly('bedtime', null);
    expect(await live(familyId, 'bedtime')).toHaveLength(3);
  });

  it('the nightly merge never folds one adult’s private fact into another spelling', async () => {
    const { familyId, a } = await seedHousehold();
    await fact(familyId, 'bedtime_routine', { in: 'one_to_one', userId: a });
    const distilled = (factKey: string) =>
      writeFact(db.database, {
        familyId,
        childId: null,
        factType: 'preference',
        factKey,
        factValue: factKey,
        confidence: 0.8,
        inferredBy: 'chat_distiller',
        heard: 'unrecorded',
        validFrom: NOW,
      });
    await distilled('bedtime-routine');
    await distilled('Bedtime Routine');

    const result = await runFamilySynthesis(db.database, familyId, NOW, true);
    // Control: the two unrecorded spellings merge into one.
    expect([result.mergedGroups, result.mergedLosers]).toEqual([1, 1]);
    expect(await live(familyId, 'bedtime_routine')).toEqual([
      { factValue: { summary: 'bedtime_routine words' }, sourceUserId: a },
    ]);
  });
});

describe('an adult who leaves takes their private facts with them', () => {
  async function departing() {
    const household = await seedHousehold();
    // B's private fact on a key that also has a shared row, and B's 1:1 logistic.
    await fact(household.familyId, 'swim', 'unrecorded');
    await fact(household.familyId, 'swim', { in: 'one_to_one', userId: household.b });
    return household;
  }

  async function bRows(familyId: string, b: string) {
    return (
      await db.database
        .select({ factKey: schema.familyMemoryFacts.factKey })
        .from(schema.familyMemoryFacts)
        .where(
          and(
            eq(schema.familyMemoryFacts.familyId, familyId),
            eq(schema.familyMemoryFacts.sourceUserId, b),
          ),
        )
    )
      .map((row) => row.factKey)
      .sort();
  }

  it('B’s erasure request deletes B’s private facts and keeps the household’s', async () => {
    const { familyId, b } = await departing();
    const erased = await requestErasure(db.database, { familyId, actorUserId: b, now: NOW });
    expect(erased).toMatchObject({
      outcome: 'co_parent_departed',
      departure: { outcome: 'departed', privateFactsDeleted: 2 },
    });
    // b_pickup is a logistic (shared by R7) and group_said was said where both heard it.
    expect(await bRows(familyId, b)).toEqual(['b_pickup', 'group_said']);
    expect(await live(familyId, 'swim')).toEqual([
      { factValue: { summary: 'swim words' }, sourceUserId: null },
    ]);
  });

  it('B’s departure does the same', async () => {
    const { familyId, a, b } = await departing();
    const departed = await departCoParent(db.database, { familyId, actorUserId: b, now: NOW });
    expect(departed).toMatchObject({ outcome: 'departed', privateFactsDeleted: 2 });
    expect(await bRows(familyId, b)).toEqual(['b_pickup', 'group_said']);
    // Control: A's own private fact is untouched.
    expect(await live(familyId, 'a_own')).toEqual([
      { factValue: { summary: 'a_own words' }, sourceUserId: a },
    ]);
  });

  it('deleting a user row whose private fact shares a key with a shared row succeeds', async () => {
    const { familyId, b } = await departing();
    await db.database.delete(schema.users).where(eq(schema.users.id, b));
    expect(await live(familyId, 'swim')).toHaveLength(2);
  });
});

/**
 * The nightly writer reads every adult's facts, so what it writes cannot say whose it is.
 * R7 shares logistics, routines and calendar or receipt facts by type, but only when the
 * row says where it was said; an `unrecorded` row is never shared by type while another
 * adult is on record, and it lives in its own scope, so it never supersedes the
 * household's.
 */
describe('a nightly fact can neither launder a private fact nor replace the household’s', () => {
  async function nightlyRoutine(familyId: string, factKey: string, validFrom = NOW) {
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'routine',
      factKey,
      factValue: `${factKey} nightly`,
      confidence: 0.9,
      inferredBy: 'memory_inferencer',
      memorySource: 'inferred',
      heard: 'unrecorded',
      validFrom,
    });
  }

  const valuesOf = (facts: { factKey: string; factValue: unknown }[], factKey: string) =>
    facts.filter((f) => f.factKey === factKey).map((f) => f.factValue);

  it('a routine the writer derived reaches neither adult in a two-adult family', async () => {
    const { familyId, a, b } = await seedHousehold();
    // B's private fact, and the routine the writer could derive from it.
    await fact(familyId, 'therapist', { in: 'one_to_one', userId: b });
    await nightlyRoutine(familyId, 'saturday_busy');
    // Control: a routine said where it was recorded is still shared by type.
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'routine',
      factKey: 'bath_night',
      factValue: 'bath_night said',
      confidence: 0.9,
      inferredBy: 'ask-hale',
      heard: { in: 'one_to_one', userId: b },
      validFrom: NOW,
    });

    for (const reader of [a, b]) {
      const coached = (await coach(familyId, reader)).memoryFacts;
      expect(valuesOf(coached, 'saturday_busy')).toEqual([]);
      expect(valuesOf(coached, 'bath_night')).toEqual(['bath_night said']);
      const recalled = await recallFamilyMemory(db.database, {
        familyId,
        now: NOW,
        reader: { adult: reader },
      });
      expect(valuesOf(recalled, 'saturday_busy')).toEqual([]);
      expect(valuesOf(recalled, 'bath_night')).toEqual(['bath_night said']);
    }
    expect(valuesOf((await coach(familyId, a, true)).memoryFacts, 'saturday_busy')).toEqual([]);
    // The access export reads the same rule row by row.
    const doc = await assembleFamilyExport(db.database, familyId, {
      actorUserId: a,
      loadTrail: async () => [],
      now: NOW,
    });
    expect(JSON.stringify(doc.memory)).not.toContain('saturday_busy');
    expect(JSON.stringify(doc.memory)).toContain('bath_night');
  });

  it('control: with one adult on record the routine is read, newest across scopes', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await nightlyRoutine(familyId, 'saturday_busy');
    await fact(familyId, 'bedtime', { in: 'family', userId: parentUserId });
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'bedtime',
      factValue: 'bedtime nightly',
      confidence: 0.9,
      inferredBy: 'chat_distiller',
      memorySource: 'inferred',
      heard: 'unrecorded',
      validFrom: new Date(NOW.getTime() + 60_000),
    });
    const coached = (await coach(familyId, parentUserId)).memoryFacts;
    expect(valuesOf(coached, 'saturday_busy')).toEqual(['saturday_busy nightly']);
    expect(valuesOf(coached, 'bedtime')).toEqual(['bedtime nightly']);
  });

  it('a nightly write on a key the household holds leaves the household row live', async () => {
    const { familyId, a, b } = await seedHousehold();
    await fact(familyId, 'bedtime', { in: 'family', userId: b });
    const nightly = (factKey: string, correctsKey: string | null) =>
      commitClassifiedMemory(db.database, {
        familyId,
        childId: null,
        factType: 'preference',
        factKey,
        factValue: `${factKey} nightly`,
        confidence: 0.9,
        inferredBy: 'chat_distiller',
        source: 'inferred',
        now: NOW,
        memoryClass: 'enduring',
        disposition: 'confirmed',
        correctsKey,
        heard: 'unrecorded',
      });

    await nightly('bedtime', null);
    const bedtime = await live(familyId, 'bedtime');
    expect(bedtime).toHaveLength(2);
    expect(bedtime).toContainEqual({ factValue: { summary: 'bedtime words' }, sourceUserId: b });
    // Control: the nightly writer still supersedes its own unrecorded row.
    await nightly('bedtime', null);
    expect(await live(familyId, 'bedtime')).toHaveLength(2);
    // Both adults keep the household's value; the unrecorded one is held back from both.
    for (const reader of [a, b]) {
      expect(valuesOf((await coach(familyId, reader)).memoryFacts, 'bedtime')).toEqual([
        { summary: 'bedtime words' },
      ]);
    }
    // A nightly correction onto another key closes only the writer's own row on it.
    await nightly('bed_time', 'bedtime');
    expect(await live(familyId, 'bedtime')).toEqual([
      { factValue: { summary: 'bedtime words' }, sourceUserId: b },
    ]);
  });
});
