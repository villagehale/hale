import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAgentContext } from '~/lib/coach/context';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { assembleMemoryBrief } from './brief';
import { runFamilyMemoryDigest } from './digest';
import { writeFact } from './facts';
import { forgetFamilyFact } from './forget';

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

describe('instinct memory evals', () => {
  it('keeps another family and a teenager out of the brief', async () => {
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
    const brief = await assembleMemoryBrief(db.database, alpha.familyId, NOW);
    expect(brief.text).toContain('pasta');
    expect(brief.text).not.toContain('BETA_ONLY');
    expect(brief.text).not.toContain('SECRET_TEEN');
    expect(brief.text).not.toContain('Noa');
  });

  it('forgets a fact on request and keeps it out of the brief', async () => {
    const { familyId } = await seedFamily(db.database, 'Correct');
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

    const forgotten = await forgetFamilyFact(db.database, {
      familyId,
      factId: second.factId,
      actor: 'parent',
      now: NOW,
    });
    expect(forgotten.forgotten).toBe(1);
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
