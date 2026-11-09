import { schema } from '@hale/db';
import { getMemorySlice } from '@hale/worker/memory-writer';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordWeekdayCare } from '~/lib/care/weekday';
import { productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import { loadPlanFacts } from '~/lib/channel/plan/reply';
import { loadAgentContext } from '~/lib/coach/context';
import { assembleFamilyExport } from '~/lib/rights/export';
import {
  type TestDb,
  createTestDb,
  seedChild,
  seedFamily,
  seedIntegration,
} from '~/lib/testing/pglite';
import { type FactHeard, writeFact } from './facts';
import { handleParentMemory } from './store';

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

describe('a forget or a correction touches only what the sender may hear (R7)', () => {
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

  it('A’s correction leaves B’s 1:1 fact as B said it; A’s own and a heard-by-both fact change', async () => {
    const { familyId, a, b } = await seedHousehold();
    await fact(familyId, 'swimming', { in: 'one_to_one', userId: b });
    await fact(familyId, 'skating', { in: 'one_to_one', userId: a });
    await fact(familyId, 'piano', { in: 'family', userId: b });

    const held = await texted(familyId, a, 'correct swimming: tuesdays');
    expect([held.outcome, held.corrected]).toEqual(['refused', 0]);
    expect(await live(familyId, 'swimming')).toEqual([
      { factValue: { summary: 'swimming words' }, sourceUserId: b },
    ]);

    expect((await texted(familyId, a, 'correct skating: tuesdays')).corrected).toBe(1);
    expect(await live(familyId, 'skating')).toEqual([{ factValue: 'tuesdays', sourceUserId: a }]);
    expect((await texted(familyId, a, 'correct piano: tuesdays')).corrected).toBe(1);
    expect(await live(familyId, 'piano')).toEqual([{ factValue: 'tuesdays', sourceUserId: a }]);
  });
});
