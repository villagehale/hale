import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { factsForContext } from '@hale/worker/memory-context';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { productionActivityFamilyReader } from '~/lib/channel/activity/reader';
import { readFamilyPlace } from '~/lib/channel/off-domain/place';
import { loadAgentContext } from '~/lib/coach/context';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { writeFact } from './facts';
import { handleParentMemory } from './store';

/**
 * VIL-519, the two Devin reds on #981. When the parent texts a correction of where they
 * live or how old a child is, the correction wins over the older record (postal code,
 * date of birth) in everything the coach reads: its location and ages, the find's town,
 * the find's ages, and the facts in the prompt. A remembered copy from before the record
 * was last written still loses.
 */
const NOW = new Date('2026-10-30T15:00:00.000Z');
const DAYS = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);
const LOCKED = { FAMILY_MEMORY_KINDS_ENABLED: 'true' };

function scriptedReply(payload: Record<string, string>): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        usage: { input_tokens: 12, output_tokens: 8 },
        stop_reason: 'end_turn',
      })),
    },
  } as unknown as AgentClient;
}

describe('a parent correction of age or home wins over the older record (VIL-519)', () => {
  let db: TestDb;
  const reader = productionActivityFamilyReader();

  beforeEach(async () => {
    db = await createTestDb();
  }, 30_000);
  afterEach(async () => {
    await db?.close();
  });

  /** A family whose home record (postal area S7K) was written 100 days ago. */
  async function family() {
    const seeded = await seedFamily(db.database);
    await db.database
      .update(schema.families)
      .set({
        city: 'Saskatoon',
        province: 'Saskatchewan',
        country: 'Canada',
        postalCode: 'S7K',
        areaCoarse: 'S7K',
        createdAt: DAYS(100),
      })
      .where(eq(schema.families.id, seeded.familyId));
    return seeded;
  }

  async function child(familyId: string, ageMonths: number) {
    const id = await seedChild(db.database, familyId, 'Quillon', ageMonths, undefined, NOW);
    await db.database
      .update(schema.children)
      .set({ createdAt: DAYS(100) })
      .where(eq(schema.children.id, id));
    return id;
  }

  async function marked(
    familyId: string,
    childId: string | null,
    key: string,
    value: Record<string, unknown>,
    seenDaysAgo: number,
    source: 'parent_message' | 'inferred' = 'inferred',
  ) {
    await writeFact(db.database, {
      familyId,
      childId,
      factType: 'logistic',
      factKey: key,
      factValue: value,
      confidence: 0.9,
      inferredBy: 'memory_inferencer',
      heard: 'unrecorded',
      validFrom: DAYS(seenDaysAgo),
      memoryKind: 'lasting',
      memorySource: source,
      sourcedAt: DAYS(seenDaysAgo),
    });
  }

  async function coach(familyId: string) {
    return loadAgentContext(
      {
        familyId,
        question: 'anything on this weekend?',
        intent: null,
        focusedChildId: null,
        transcript: [],
        sourceNote: null,
      },
      db.database,
      NOW,
    );
  }

  it('a home the parent named after the record is the coach location, the find town and a prompt fact', async () => {
    const { familyId } = await family();
    await marked(familyId, null, 'home_city', { text: 'Regina', record: 'place' }, 2);

    const ctx = await coach(familyId);
    expect(ctx.location.city).toBe('Regina');
    expect(ctx.memoryFacts.map((f) => f.factKey)).toContain('home_city');
    const place = await reader.place(db.database, familyId);
    expect(place).toEqual({ status: 'known', town: 'Regina, Canada' });
    expect((await reader.familyFit?.(db.database, familyId, 'every_adult', NOW))?.homeArea).toBe('Regina, Canada');
  });

  it('a remembered home from before the record, or before a later settings edit, still loses', async () => {
    const { familyId, parentUserId } = await family();
    await marked(familyId, null, 'home_city', { text: 'Regina', record: 'place' }, 150);

    let ctx = await coach(familyId);
    expect(ctx.location.city).toBe('Saskatoon');
    expect(ctx.memoryFacts.map((f) => f.factKey)).not.toContain('home_city');

    // Said after the record, then the parent edits the record in settings: the edit wins.
    await marked(familyId, null, 'lives_in', { text: 'Regina', record: 'place' }, 5);
    expect((await coach(familyId)).location.city).toBe('Regina');
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: parentUserId,
      actionTaken: 'family_location_updated',
      targetTable: 'families',
      targetId: familyId,
      occurredAt: DAYS(1),
    });
    ctx = await coach(familyId);
    expect(ctx.location.city).toBe('Saskatoon');
    expect(ctx.memoryFacts.map((f) => f.factKey)).not.toContain('lives_in');
    expect(await reader.place(db.database, familyId)).toEqual({
      status: 'known',
      town: 'Saskatoon, Saskatchewan, Canada',
    });
  });

  it('a parent `correct` of a marked home keeps the mark, and the corrected town wins everywhere (Devin, store.ts:702)', async () => {
    const { familyId, parentUserId } = await family();
    await marked(familyId, null, 'home_city', { text: 'Saskatoon', record: 'place' }, 150);

    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'correct home_city: Regina',
      now: NOW,
      inboundChannelMessageId: null,
      env: LOCKED,
      replyClient: scriptedReply({ text: 'Got it.' }),
    });
    expect(result.corrected).toBe(1);

    const facts = await factsForContext(db.database, familyId, {
      now: NOW,
      reader: 'every_adult',
      limit: 20,
    });
    expect(facts.map((row) => [row.factKey, row.factValue])).toEqual([
      ['home_city', { text: 'Regina', record: 'place' }],
    ]);
    expect((await coach(familyId)).location.city).toBe('Regina');
    expect(await reader.place(db.database, familyId)).toEqual({
      status: 'known',
      town: 'Regina, Canada',
    });
  });

  it('a home in words the place tables do not hold is not the city: the record stays and the words ride as a fact', async () => {
    const { familyId } = await family();
    await marked(
      familyId,
      null,
      'home',
      { summary: 'moved across the country', record: 'place' },
      3,
    );

    const ctx = await coach(familyId);
    expect(ctx.location.city).toBe('Saskatoon');
    expect(ctx.memoryFacts.map((f) => f.factKey)).toContain('home');
    expect(await reader.place(db.database, familyId)).toEqual({
      status: 'known',
      town: 'Saskatoon, Saskatchewan, Canada',
    });

    // A table name, in any case, is the place, in the table's spelling.
    await marked(familyId, null, 'home_now', { text: '  REGINA ', record: 'place' }, 1);
    expect((await coach(familyId)).location.city).toBe('Regina');
    expect(await readFamilyPlace(db.database, familyId)).toEqual({
      status: 'known',
      city: 'Regina',
      country: 'Canada',
    });
  });

  it('a home correction naming a street and a teen never reaches the coach, the find or the search as the city', async () => {
    const { familyId } = await family();
    await child(familyId, 14 * 12 + 2);
    await marked(
      familyId,
      null,
      'home',
      { text: 'Quillon and I moved in with her grandma on 12 Elm Street', record: 'place' },
      2,
    );

    const ctx = await coach(familyId);
    expect(ctx.location.city).toBe('Saskatoon');
    expect(JSON.stringify(ctx)).not.toContain('Elm Street');
    expect(await reader.place(db.database, familyId)).toEqual({
      status: 'known',
      town: 'Saskatoon, Saskatchewan, Canada',
    });
    expect(await readFamilyPlace(db.database, familyId)).toEqual({
      status: 'known',
      city: 'Saskatoon',
      country: 'Canada',
    });
  });

  it('a family-wide age correction is never credited to an only child who is 13 or older', async () => {
    const teenFamily = await family();
    await child(teenFamily.familyId, 14 * 12 + 2);
    await marked(
      teenFamily.familyId,
      null,
      'age',
      { text: 'just turned fifteen', record: 'age' },
      2,
      'parent_message',
    );
    const teenFacts = await factsForContext(db.database, teenFamily.familyId, {
      now: NOW,
      reader: 'every_adult',
      limit: 20,
    });
    expect(teenFacts.map((row) => row.factKey)).not.toContain('age');

    // Positive control: the same correction for an only child of nine rides.
    const younger = await family();
    await child(younger.familyId, 9 * 12);
    await marked(
      younger.familyId,
      null,
      'age',
      { text: 'just turned ten', record: 'age' },
      2,
      'parent_message',
    );
    const facts = await factsForContext(db.database, younger.familyId, {
      now: NOW,
      reader: 'every_adult',
      limit: 20,
    });
    expect(facts.map((row) => row.factKey)).toContain('age');
  });

  it("a child's age the parent gave after the date of birth was written is the coach's and the find's age", async () => {
    const { familyId } = await family();
    const kid = await child(familyId, 36);
    await marked(familyId, kid, 'age', { ageMonths: 60, record: 'age' }, 31, 'parent_message');

    const ctx = await coach(familyId);
    expect(ctx.children.find((c) => c.id === kid)?.ageMonths).toBe(61);
    expect(ctx.memoryFacts.map((f) => f.factKey)).toContain('age');
    const fit = await reader.familyFit?.(db.database, familyId, 'every_adult', NOW);
    expect(fit?.children.find((c) => c.childId === kid)?.ageYears).toBe(5);
  });

  it('an age correction in words leaves the age unknown and rides as the fact; an older copy loses', async () => {
    const { familyId } = await family();
    const kid = await child(familyId, 36);
    await marked(familyId, kid, 'birthday', { text: 'turned five last week', record: 'age' }, 150);

    let ctx = await coach(familyId);
    expect(ctx.children.find((c) => c.id === kid)?.ageMonths).toBe(36);
    expect(ctx.memoryFacts.map((f) => f.factKey)).not.toContain('birthday');

    await marked(familyId, kid, 'age_now', { text: 'turned five last week', record: 'age' }, 2);
    ctx = await coach(familyId);
    expect(ctx.children.find((c) => c.id === kid)?.ageMonths).toBeNull();
    expect(ctx.memoryFacts.map((f) => f.factKey)).toEqual(['age_now']);
    const fit = await reader.familyFit?.(db.database, familyId, 'every_adult', NOW);
    expect(fit?.children.find((c) => c.childId === kid)?.ageYears).toBeNull();
  });
});
