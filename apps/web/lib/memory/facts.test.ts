import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAskHaleTools } from '~/lib/coach/tools';
import { buildDistillTools, buildInferenceTools } from '~/lib/cron/inference-tools';
import { recordCheckpointDone } from '~/lib/health/reply';
import { recordRegistrationOutcome } from '~/lib/registration/sequence/reply';
import { createTestDb, seedChild, seedFamily, type TestDb } from '~/lib/testing/pglite';

/**
 * MEM-2 / MEM-3 — what a memory WRITE is obliged to record.
 *
 * The schema promises a provenance chain (`superseded_by`), an event-time axis
 * (`valid_from`) and a ranking signal (`confidence`). Every writer under-delivered
 * on at least one, and the identity of a fact — what a new value replaces — was
 * spelled differently in each of them. These assert the obligations at the writers
 * themselves, against real Postgres, because the partial unique index that makes
 * "one live fact per key" true is a database object no fake can stand in for.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

const ctx = (familyId: string) => ({ familyId, actor: 'system' });

function toolNamed(tools: ReturnType<typeof buildAskHaleTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`no tool ${name}`);
  return tool;
}

async function liveFacts(familyId: string) {
  return db.database
    .select()
    .from(schema.familyMemoryFacts)
    .where(eq(schema.familyMemoryFacts.familyId, familyId));
}

async function liveFact(familyId: string, factKey: string) {
  const rows = await db.database
    .select()
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        eq(schema.familyMemoryFacts.factKey, factKey),
      ),
    );
  return rows;
}

describe('coach save_memory (ask-hale)', () => {
  const TURN_AT = new Date('2026-03-04T15:20:00.000Z');

  it('stamps valid_from with the turn the parent said it, not the row insert time', async () => {
    const { familyId } = await seedFamily(db.database);
    const save = toolNamed(buildAskHaleTools(db.database, TURN_AT), 'save_memory');

    await save.handler(
      { factType: 'routine', factKey: 'dinner_time', factValue: { at: '18:00' }, confidence: 1 },
      ctx(familyId),
    );

    const [fact] = await liveFact(familyId, 'dinner_time');
    expect(fact?.validFrom).toEqual(TURN_AT);
  });

  it("persists the model's stated confidence rather than asserting certainty for it", async () => {
    const { familyId } = await seedFamily(db.database);
    const save = toolNamed(buildAskHaleTools(db.database, TURN_AT), 'save_memory');

    await save.handler(
      { factType: 'preference', factKey: 'park', factValue: { name: 'Trinity Bellwoods' }, confidence: 0.75 },
      ctx(familyId),
    );

    const [fact] = await liveFact(familyId, 'park');
    expect(fact?.confidence).toBe(0.75);
  });

  it('refuses a fact below the confidence floor instead of writing a hunch', async () => {
    const { familyId } = await seedFamily(db.database);
    const save = toolNamed(buildAskHaleTools(db.database, TURN_AT), 'save_memory');

    const result = await save.handler(
      { factType: 'preference', factKey: 'maybe', factValue: { x: 1 }, confidence: 0.4 },
      ctx(familyId),
    );

    expect(result).toEqual({ saved: false, reason: 'below_confidence_floor' });
    expect(await liveFacts(familyId)).toHaveLength(0);
  });

  it('points the replaced fact at its replacement (superseded_by)', async () => {
    const { familyId } = await seedFamily(db.database);
    const save = toolNamed(buildAskHaleTools(db.database, TURN_AT), 'save_memory');
    const args = { factType: 'routine' as const, factKey: 'naptime', confidence: 1 };

    await save.handler({ ...args, factValue: { at: '12:00' } }, ctx(familyId));
    const second = (await save.handler({ ...args, factValue: { at: '13:00' } }, ctx(familyId))) as {
      factId: string;
    };

    const rows = await liveFact(familyId, 'naptime');
    const closed = rows.filter((r) => r.validUntil !== null);
    expect(rows).toHaveLength(2);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.supersededBy).toBe(second.factId);
  });
});

describe('memory inferencer save_memory', () => {
  const RUN_AT = new Date('2026-03-10T06:00:00.000Z');

  it('records when the fact became true, not when the cron noticed', async () => {
    const { familyId } = await seedFamily(db.database);
    const save = toolNamed(buildInferenceTools(db.database, RUN_AT), 'save_memory');
    // The snapshot the inferencer reads carries the source event's own timestamp;
    // a fact learned on the 10th about the 6th is valid from the 6th.
    const observedAt = '2026-03-06T14:00:00.000Z';

    await save.handler(
      { factType: 'logistic', factKey: 'daycare_start', factValue: { at: 'Sept' }, confidence: 0.9, observedAt },
      ctx(familyId),
    );

    const [fact] = await liveFact(familyId, 'daycare_start');
    expect(fact?.validFrom).toEqual(new Date(observedAt));
  });

  it('falls back to the run clock when no source time is offered', async () => {
    const { familyId } = await seedFamily(db.database);
    const save = toolNamed(buildInferenceTools(db.database, RUN_AT), 'save_memory');

    await save.handler(
      { factType: 'logistic', factKey: 'undated', factValue: { x: 1 }, confidence: 0.9 },
      ctx(familyId),
    );

    const [fact] = await liveFact(familyId, 'undated');
    expect(fact?.validFrom).toEqual(RUN_AT);
  });

  it('ignores a source time the model invented in the future', async () => {
    const { familyId } = await seedFamily(db.database);
    const save = toolNamed(buildInferenceTools(db.database, RUN_AT), 'save_memory');

    await save.handler(
      {
        factType: 'logistic',
        factKey: 'future',
        factValue: { x: 1 },
        confidence: 0.9,
        observedAt: '2027-01-01T00:00:00.000Z',
      },
      ctx(familyId),
    );

    const [fact] = await liveFact(familyId, 'future');
    expect(fact?.validFrom).toEqual(RUN_AT);
  });
});

describe('chat distiller save_child_fact', () => {
  const RUN_AT = new Date('2026-03-10T06:00:00.000Z');

  it("does not retire a sibling's fact that happens to share a key", async () => {
    const { familyId } = await seedFamily(db.database);
    const ella = await seedChild(db.database, familyId, 'Ella', 30);
    const noah = await seedChild(db.database, familyId, 'Noah', 84);
    const save = toolNamed(buildDistillTools(db.database, RUN_AT), 'save_child_fact');
    const args = { category: 'routines' as const, factKey: 'bedtime', confidence: 0.9 };

    await save.handler({ ...args, childId: ella, summary: 'Ella goes down at 7' }, ctx(familyId));
    await save.handler({ ...args, childId: noah, summary: 'Noah goes down at 8' }, ctx(familyId));

    const live = (await liveFacts(familyId)).filter((f) => f.validUntil === null);
    expect(live.map((f) => f.childId).sort()).toEqual([ella, noah].sort());
  });

  it("retires only that child's own earlier fact", async () => {
    const { familyId } = await seedFamily(db.database);
    const ella = await seedChild(db.database, familyId, 'Ella', 30);
    const save = toolNamed(buildDistillTools(db.database, RUN_AT), 'save_child_fact');
    const args = { category: 'routines' as const, factKey: 'bedtime', childId: ella, confidence: 0.9 };

    await save.handler({ ...args, summary: 'down at 7' }, ctx(familyId));
    const second = (await save.handler({ ...args, summary: 'down at 7:30' }, ctx(familyId))) as {
      factId: string;
    };

    const rows = await liveFacts(familyId);
    const closed = rows.filter((r) => r.validUntil !== null);
    expect(rows).toHaveLength(2);
    expect(closed[0]?.supersededBy).toBe(second.factId);
  });
});

describe('the non-agent fact writers', () => {
  it('a health checkpoint marked done twice leaves ONE live fact', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const child = await seedChild(db.database, familyId, 'Ella', 30);
    const input = {
      familyId,
      parentUserId,
      childId: child,
      checkpointId: 'cp-18mo',
      ref: '18mo-visit',
    };

    await recordCheckpointDone(db.database, input);
    await recordCheckpointDone(db.database, input);

    const live = (await liveFacts(familyId)).filter((f) => f.validUntil === null);
    expect(live).toHaveLength(1);
  });

  it('a registration outcome recorded twice leaves ONE live fact', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const input = {
      sequenceId: '22222222-2222-4222-8222-222222222222',
      familyId,
      parentUserId,
      windowRef: {
        id: 'window-1',
        municipality: 'Toronto',
        programDomain: 'swim',
        cycleLabel: 'Fall 2026',
      } as never,
      outcome: 'registered' as const,
      position: null,
      waitlistStartedAt: null,
      waitlistDeadlineAt: null,
      now: new Date('2026-03-10T06:00:00.000Z'),
    };

    await recordRegistrationOutcome(db.database, input);
    await recordRegistrationOutcome(db.database, input);

    const live = (await liveFacts(familyId)).filter((f) => f.validUntil === null);
    expect(live).toHaveLength(1);
  });
});
