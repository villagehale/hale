import { schema } from '@hale/db';
import { deriveStage } from '@hale/types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAgentContext } from '~/lib/coach/context';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { assembleMemoryBrief } from './brief';
import { runFamilyMemoryDigest } from './digest';
import { writeFact } from './facts';
import { forgetFamilyFact } from './forget';
import { loadFactHistory, searchFamilyMemory } from './search';

/**
 * Fixture evals for Instinct-style memory. Deterministic on purpose: rule #8
 * forbids a mocked model, and these behaviors are retrieval and reconciliation,
 * not a generation the model has to invent.
 */

const NOW = new Date('2026-09-23T06:48:00.000Z');
const IN_DAY = new Date('2026-09-22T15:00:00.000Z');
const IN_WEEK_ONLY = new Date('2026-09-21T15:00:00.000Z');
const OUTSIDE = new Date('2026-09-23T05:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function teens(familyId: string): Promise<Set<string>> {
  const rows = await db.database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return new Set(
    rows.filter((row) => deriveStage(row.dateOfBirth, NOW) === 'teenager').map((row) => row.id),
  );
}

describe('instinct memory evals', () => {
  it('recalls one fact, ranks a newer equal match first, and abstains on a miss or a typo', async () => {
    const { familyId } = await seedFamily(db.database, 'Recall');
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'pasta_lunch',
      factValue: 'Tuesday pasta',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: new Date('2026-09-01T00:00:00Z'),
    });
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'pasta_dinner',
      factValue: 'Friday pasta',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: new Date('2026-09-20T00:00:00Z'),
    });
    const teenIds = await teens(familyId);
    const hits = await searchFamilyMemory(db.database, {
      familyId,
      query: 'pasta',
      teenChildIds: teenIds,
    });
    expect(hits.map((hit) => hit.factKey)).toEqual(['pasta_dinner', 'pasta_lunch']);
    expect(
      await searchFamilyMemory(db.database, {
        familyId,
        query: 'zzzz-not-a-fact',
        teenChildIds: teenIds,
      }),
    ).toEqual([]);
    expect(
      await searchFamilyMemory(db.database, { familyId, query: 'pazta', teenChildIds: teenIds }),
    ).toEqual([]);
    expect(
      await searchFamilyMemory(db.database, { familyId, query: 'pastaa', teenChildIds: teenIds }),
    ).toEqual([]);
  });

  it('links two facts that share a token and a daycare alias', async () => {
    const { familyId } = await seedFamily(db.database, 'Hop');
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'relationship',
      factKey: 'partner_clinic',
      factValue: 'riverside clinic',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: NOW,
    });
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'logistic',
      factKey: 'clinic_hours',
      factValue: 'closes at 5',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: NOW,
    });
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'logistic',
      factKey: 'childcare_pickup',
      factValue: 'riverside',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: NOW,
    });
    const teenIds = await teens(familyId);
    const clinic = await searchFamilyMemory(db.database, {
      familyId,
      query: 'clinic',
      teenChildIds: teenIds,
    });
    expect(clinic.map((hit) => hit.factKey).sort()).toEqual(['clinic_hours', 'partner_clinic']);
    const daycare = await searchFamilyMemory(db.database, {
      familyId,
      query: 'daycare',
      teenChildIds: teenIds,
    });
    expect(daycare.map((hit) => hit.factKey)).toEqual(['childcare_pickup']);
  });

  it('keeps another family and a teenager out of search and the brief', async () => {
    const alpha = await seedFamily(db.database, 'Alpha');
    const beta = await seedFamily(db.database, 'Beta');
    const teenId = await seedChild(db.database, alpha.familyId, 'Noa', 170);
    await writeFact(db.database, {
      familyId: alpha.familyId,
      childId: null,
      factType: 'preference',
      factKey: 'dining',
      factValue: 'pasta',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: NOW,
    });
    await writeFact(db.database, {
      familyId: beta.familyId,
      childId: null,
      factType: 'preference',
      factKey: 'dining',
      factValue: 'BETA_ONLY',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: NOW,
    });
    await writeFact(db.database, {
      familyId: alpha.familyId,
      childId: teenId,
      factType: 'medical',
      factKey: 'teen_secret',
      factValue: 'SECRET_TEEN',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: NOW,
    });
    const teenIds = await teens(alpha.familyId);
    const hits = await searchFamilyMemory(db.database, {
      familyId: alpha.familyId,
      query: 'dining secret',
      teenChildIds: teenIds,
    });
    expect(hits.map((hit) => hit.factValue)).toEqual(['pasta']);
    const brief = await assembleMemoryBrief(db.database, alpha.familyId, NOW);
    expect(brief.text).toContain('pasta');
    expect(brief.text).not.toContain('BETA_ONLY');
    expect(brief.text).not.toContain('SECRET_TEEN');
    expect(brief.text).not.toContain('Noa');
  });

  it('supersedes a correction, forgets on request, and keeps history opt-in', async () => {
    const { familyId } = await seedFamily(db.database, 'Correct');
    const first = await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'routine',
      factKey: 'bedtime',
      factValue: '7pm',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: new Date('2026-09-01T00:00:00Z'),
    });
    const second = await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'routine',
      factKey: 'bedtime',
      factValue: '8pm',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: new Date('2026-09-20T00:00:00Z'),
    });
    const teenIds = await teens(familyId);
    const live = await searchFamilyMemory(db.database, {
      familyId,
      query: 'bedtime',
      teenChildIds: teenIds,
    });
    expect(live.map((hit) => hit.factValue)).toEqual(['8pm']);
    const history = await loadFactHistory(db.database, {
      familyId,
      factId: second.factId,
      teenChildIds: teenIds,
    });
    expect(history.found).toBe(true);
    if (history.found) {
      expect(history.nodes.map((node) => node.factValue)).toEqual(['7pm', '8pm']);
      expect(history.nodes[0]?.id).toBe(first.factId);
    }

    const forgotten = await forgetFamilyFact(db.database, {
      familyId,
      factId: second.factId,
      actor: 'parent',
      now: NOW,
    });
    expect(forgotten.forgotten).toBe(1);
    expect(
      await searchFamilyMemory(db.database, { familyId, query: 'bedtime', teenChildIds: teenIds }),
    ).toEqual([]);
    const withHistory = await searchFamilyMemory(db.database, {
      familyId,
      query: 'bedtime',
      teenChildIds: teenIds,
      includeHistory: true,
    });
    expect(withHistory.map((hit) => hit.factValue)).toContain('8pm');
    const brief = await assembleMemoryBrief(db.database, familyId, NOW);
    expect(brief.text).not.toContain('8pm');

    const receipt = await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'logistic',
      factKey: 'health_checkpoint:18mo',
      factValue: 'done',
      confidence: 1,
      inferredBy: 'health-nudge-reply',
      validFrom: NOW,
    });
    const refused = await forgetFamilyFact(db.database, {
      familyId,
      factId: receipt.factId,
      actor: 'parent',
      now: NOW,
    });
    expect(refused.refusedControlPlane).toBe(1);
    expect(refused.forgotten).toBe(0);
  });

  it('caps a long supersede chain and a wide search', async () => {
    const { familyId } = await seedFamily(db.database, 'Bound');
    let latest = '';
    for (let i = 0; i < 25; i += 1) {
      const written = await writeFact(db.database, {
        familyId,
        childId: null,
        factType: 'preference',
        factKey: 'chain',
        factValue: `v${i}`,
        confidence: 1,
        inferredBy: 'ask-hale',
        validFrom: new Date(Date.UTC(2026, 0, i + 1)),
      });
      latest = written.factId;
    }
    await db.database.insert(schema.familyMemoryFacts).values(
      Array.from({ length: 200 }, (_, i) => ({
        familyId,
        childId: null,
        factType: 'logistic' as const,
        factKey: `note_${i}`,
        factValue: { i },
        confidence: 1,
        inferredBy: 'ask-hale',
        validFrom: NOW,
      })),
    );
    const teenIds = await teens(familyId);
    const history = await loadFactHistory(db.database, {
      familyId,
      factId: latest,
      teenChildIds: teenIds,
    });
    expect(history.found).toBe(true);
    if (history.found) {
      expect(history.nodes.length).toBeLessThanOrEqual(20);
      expect(history.truncated).toBe(true);
      expect(history.nodes.at(-1)?.factValue).toBe('v24');
    }
    const wide = await searchFamilyMemory(db.database, {
      familyId,
      query: 'note',
      teenChildIds: teenIds,
    });
    expect(wide.length).toBeLessThanOrEqual(8);
    expect(wide.length).toBeGreaterThan(0);
  });

  it('writes one day and one week digest, skips message text, and is idempotent', async () => {
    const family = await seedFamily(db.database, 'Digest');
    await db.database.insert(schema.channelMessages).values([
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        body: 'SECRET_BODY_TOKEN',
        createdAt: IN_DAY,
      },
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channel: 'sms',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        body: 'WEEK_ONLY_BODY',
        createdAt: IN_WEEK_ONLY,
      },
      {
        familyId: family.familyId,
        parentUserId: family.parentUserId,
        channel: 'sms',
        direction: 'out',
        category: 'reply',
        status: 'sent',
        createdAt: OUTSIDE,
      },
    ]);
    const [conversation] = await db.database
      .insert(schema.conversations)
      .values({ familyId: family.familyId })
      .returning({ id: schema.conversations.id });
    await db.database.insert(schema.messages).values({
      conversationId: conversation?.id as string,
      role: 'user',
      content: 'SECRET_MESSAGE_TOKEN',
      topic: 'sleep',
      createdAt: IN_DAY,
    });
    await db.database.insert(schema.agentCommitments).values({
      familyId: family.familyId,
      commitmentKind: 'first_find',
      createdFrom: 'msg-1',
      summary: 'SECRET_SUMMARY',
      dueAt: new Date('2026-09-25T15:00:00Z'),
    });
    await writeFact(db.database, {
      familyId: family.familyId,
      childId: null,
      factType: 'routine',
      factKey: 'bedtime',
      factValue: '7pm',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: NOW,
    });
    await writeFact(db.database, {
      familyId: family.familyId,
      childId: null,
      factType: 'routine',
      factKey: 'bed-time',
      factValue: '7:30pm',
      confidence: 0.9,
      inferredBy: 'chat_distiller',
      validFrom: NOW,
    });
    await writeFact(db.database, {
      familyId: family.familyId,
      childId: null,
      factType: 'logistic',
      factKey: 'ephemeral.pickup',
      factValue: 'temporary',
      confidence: 1,
      inferredBy: 'ask-hale',
      validFrom: new Date('2026-08-01T00:00:00Z'),
    });

    const observed = await runFamilyMemoryDigest(db.database, family.familyId, NOW, false);
    expect(observed.added).toBe(2);
    expect(observed.contradictionCandidates).toBe(1);
    const storedObserved = await db.database
      .select({ id: schema.familyMemoryDigests.id })
      .from(schema.familyMemoryDigests)
      .where(eq(schema.familyMemoryDigests.familyId, family.familyId));
    expect(storedObserved).toEqual([]);

    const applied = await runFamilyMemoryDigest(db.database, family.familyId, NOW, true);
    expect(applied.added).toBe(2);
    expect(applied.superseded).toBe(1);
    const again = await runFamilyMemoryDigest(db.database, family.familyId, NOW, true);
    expect(again.added).toBe(0);
    expect(again.unchanged).toBe(2);
    expect(again.superseded).toBe(0);

    const digests = await db.database
      .select()
      .from(schema.familyMemoryDigests)
      .where(eq(schema.familyMemoryDigests.familyId, family.familyId));
    expect(digests).toHaveLength(2);
    const serialized = JSON.stringify(digests);
    expect(serialized).not.toContain('SECRET_BODY_TOKEN');
    expect(serialized).not.toContain('SECRET_MESSAGE_TOKEN');
    expect(serialized).not.toContain('SECRET_SUMMARY');
    expect(serialized).not.toContain('WEEK_ONLY_BODY');
    const day = digests.find((row) => row.grain === 'day');
    const week = digests.find((row) => row.grain === 'week');
    expect(day?.periodStart).toBe('2026-09-22');
    expect(week?.periodStart).toBe('2026-09-21');
    expect((day?.summary as { inbound: number }).inbound).toBe(1);
    expect((week?.summary as { inbound: number }).inbound).toBe(2);
    expect((day?.summary as { byTopic: Record<string, number> }).byTopic.sleep).toBe(1);
    expect(
      (day?.summary as { openWorkstreams: Array<{ kind: string }> }).openWorkstreams[0]?.kind,
    ).toBe('first_find');

    const context = await loadAgentContext(
      {
        familyId: family.familyId,
        question: 'what should we do for dinner?',
        intent: null,
        focusedChildId: null,
        transcript: [],
        sourceNote: null,
      },
      db.database,
      NOW,
    );
    expect(context.memoryBrief.text).toContain('first_find');
    expect(context.memoryBrief.text).not.toContain('SECRET_SUMMARY');
    expect(context.memoryBrief.status === 'ok' || context.memoryBrief.status === 'stale').toBe(
      true,
    );
  });
});
