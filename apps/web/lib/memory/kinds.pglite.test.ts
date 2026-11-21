import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { writeFact } from './facts';
import { familyMemoryKindsHandler } from './handler';
import { asked, refsFor, scriptedMemoryScreen } from './scripted-memory-screen.fixture';
import {
  handleParentMemory,
  loadRecommendationMemory,
  memoryTypingForWrite,
  promoteMatchingInferredFacts,
  recallFamilyMemory,
} from './store';

const NOW = new Date('2026-09-30T15:00:00.000Z');
const ON = { FAMILY_MEMORY_KINDS_ENABLED: 'true' };
const LOCKED = {
  FAMILY_MEMORY_KINDS_ENABLED: 'true',
};

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

/** The context the composer handed the model on its first call (its first user turn). */
function firstContext(client: AgentClient): { purpose?: string; facts: string[] } {
  const create = client.messages.create as unknown as {
    mock: { calls: Array<[{ messages: Array<{ content: unknown }> }]> };
  };
  const content = create.mock.calls[0]?.[0].messages[0]?.content;
  const text =
    typeof content === 'string'
      ? content
      : ((content as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')?.text ??
        '{}');
  return JSON.parse(text) as { purpose?: string; facts: string[] };
}

// The screen's readings are scripted per test: how the model reads real wording, in any
// language, is the meaning-screen eval (rule #8). What these tests hold is what is acted on.
const FORGET_SWIMMING = scriptedMemoryScreen({
  request: () => asked('forget', { target: 'swimming' }),
  target: (_text, facts) => ({ hit: true, refs: refsFor(facts, 'swimming') }),
});
const CORRECT_SWIMMING = scriptedMemoryScreen({
  request: () => asked('correct', { target: 'swimming', value: 'not for us' }),
  target: (_text, facts) => ({ hit: true, refs: refsFor(facts, 'swimming'), value: 'not for us' }),
});
const LISTING = scriptedMemoryScreen({ request: () => asked('list') });

describe('migration 0141 backfill', () => {
  let db: TestDb;

  beforeEach(async () => {
    db = await createTestDb('0139_authorized_signup_consent.sql');
  }, 30_000);

  afterEach(async () => {
    await db?.close();
  });

  it('marks existing rows lasting and legacy, and copies sourced_at from created_at', async () => {
    const { familyId } = await seedFamily(db.database);
    // Raw SQL: the Drizzle insert names columns this migration has not added yet.
    const inserted = (await db.database.execute(
      sql`insert into family_memory_facts (family_id, fact_type, fact_key, fact_value, confidence)
        values (${familyId}, 'preference', 'swimming', ${JSON.stringify({ note: 'once' })}::jsonb, 0.9)
        returning id`,
    )) as unknown as { rows?: Array<{ id: string }> };

    await db.applyMigration('0141_family_memory_kinds.sql');

    const [row] = await db.database
      .select({
        memoryKind: schema.familyMemoryFacts.memoryKind,
        memorySource: schema.familyMemoryFacts.memorySource,
        sourcedAt: schema.familyMemoryFacts.sourcedAt,
        signalCount: schema.familyMemoryFacts.signalCount,
        expiresAt: schema.familyMemoryFacts.expiresAt,
      })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, familyId));

    const seeded = (Array.isArray(inserted) ? inserted : (inserted.rows ?? []))[0];
    expect(seeded?.id).toBeTruthy();
    expect(row).toMatchObject({
      memoryKind: 'lasting',
      memorySource: 'legacy',
      signalCount: 0,
      expiresAt: null,
    });
    expect(row?.sourcedAt).toBeInstanceOf(Date);
  });
});

describe('family memory kinds', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  async function seedSwim(kind: 'lasting' | 'temporary' | 'one_off', expiresAt?: Date) {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const written = await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'swimming',
      factValue: 'saturday class',
      confidence: 0.9,
      inferredBy: 'memory_inferencer',
      heard: 'unrecorded',
      validFrom: NOW,
      memoryKind: kind,
      memorySource: kind === 'lasting' ? 'legacy' : 'inferred',
      sourcedAt: NOW,
      expiresAt: expiresAt ?? null,
      signalCount: 0,
    });
    return { familyId, parentUserId, factId: written.factId };
  }

  it('is a no-op while the flag is off: the aside still feeds recommendations and nothing is forgotten', async () => {
    const { familyId, parentUserId } = await seedSwim('one_off');
    const before = await loadRecommendationMemory(db.database, familyId, NOW, {});
    expect(before.map((row) => row.factKey)).toEqual(['swimming']);

    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'forget swimming',
      now: NOW,
      inboundChannelMessageId: null,
      env: {},
      sendGroup: vi.fn(),
    });
    expect(result.claimed).toBe(false);
    expect(result.reply).toBeNull();

    const [live] = await db.database
      .select({ validUntil: schema.familyMemoryFacts.validUntil })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, familyId));
    expect(live?.validUntil).toBeNull();
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audits).toEqual([]);
  });

  it('recommends lasting and unexpired temporary facts only when the flag is on', async () => {
    const { familyId } = await seedFamily(db.database);
    const past = new Date(NOW.getTime() - 60_000);
    const future = new Date(NOW.getTime() + 60_000);
    for (const row of [
      { factKey: 'district', kind: 'lasting' as const, expiresAt: null },
      { factKey: 'swimming', kind: 'one_off' as const, expiresAt: null },
      { factKey: 'this_term', kind: 'temporary' as const, expiresAt: future },
      { factKey: 'last_week', kind: 'temporary' as const, expiresAt: past },
    ]) {
      await writeFact(db.database, {
        familyId,
        childId: null,
        factType: 'preference',
        factKey: row.factKey,
        factValue: row.factKey,
        confidence: 0.9,
        inferredBy: 'memory_inferencer',
        heard: 'unrecorded',
        validFrom: NOW,
        memoryKind: row.kind,
        memorySource: 'inferred',
        sourcedAt: NOW,
        expiresAt: row.expiresAt,
        signalCount: 0,
      });
    }

    const off = await loadRecommendationMemory(db.database, familyId, NOW, {});
    expect(off.map((row) => row.factKey).sort()).toEqual([
      'district',
      'last_week',
      'swimming',
      'this_term',
    ]);

    const on = await loadRecommendationMemory(db.database, familyId, NOW, ON);
    expect(on.map((row) => row.factKey).sort()).toEqual(['district', 'this_term']);
  });

  it('soft-invalidates a forget and audits it, without sending the placeholder', async () => {
    const { familyId, parentUserId } = await seedSwim('one_off');
    const sendGroup = vi.fn(async (_chatId: string, _body: string) => 'sent' as const);
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: `group-${familyId}` })
      .where(eq(schema.families.id, familyId));
    const [inbound] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'imessage',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        providerChatId: `one-${familyId}`,
        body: 'forget swimming',
      })
      .returning({ id: schema.channelMessages.id });

    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'forget swimming',
      now: NOW,
      inboundChannelMessageId: inbound?.id ?? null,
      env: ON,
      sendGroup,
      screen: FORGET_SWIMMING,
    });

    expect(result).toMatchObject({
      claimed: true,
      outcome: 'forgotten',
      forgotten: 1,
      reply: null,
    });
    expect(sendGroup).toHaveBeenCalledTimes(1);
    expect(sendGroup.mock.calls[0]?.[1]).toBe('Test asked me to forget something.');
    expect(String(sendGroup.mock.calls[0]?.[1])).not.toContain('swimming');
    expect(JSON.stringify(result)).not.toContain('TODO-Design');

    const [row] = await db.database
      .select({ validUntil: schema.familyMemoryFacts.validUntil })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, familyId));
    expect(row?.validUntil).not.toBeNull();

    const [audit] = await db.database
      .select({
        actionTaken: schema.auditLog.actionTaken,
        targetTable: schema.auditLog.targetTable,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audit).toMatchObject({
      actionTaken: 'memory_fact_forgotten',
      targetTable: 'family_memory_facts',
    });
  });

  it('syncs a locked correction to the group chat and not the 1:1', async () => {
    const { familyId, parentUserId } = await seedSwim('one_off');
    const groupChatId = `group-${familyId}`;
    const sendGroup = vi.fn(async (chatId: string, body: string) => {
      expect(chatId).toBe(groupChatId);
      expect(body).toBe('Test corrected something.');
      return 'sent' as const;
    });
    await db.database
      .update(schema.families)
      .set({ linqGroupChatId: groupChatId })
      .where(eq(schema.families.id, familyId));
    const [inbound] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'imessage',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        providerChatId: `one-${familyId}`,
        inGroup: false,
      })
      .returning({ id: schema.channelMessages.id });

    const modelReply = 'Got it, swimming is now not for us. Say so here if that is wrong.';
    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'swimming is not for us any more',
      now: NOW,
      inboundChannelMessageId: inbound?.id ?? null,
      env: LOCKED,
      sendGroup,
      replyClient: scriptedReply({ text: modelReply }),
      screen: CORRECT_SWIMMING,
    });

    expect(result.corrected).toBe(1);
    expect(result.reply).toBe(modelReply);
    expect(sendGroup).toHaveBeenCalledTimes(1);
    expect(sendGroup.mock.calls[0]?.[1]).toBe('Test corrected something.');
    expect(String(sendGroup.mock.calls[0]?.[1])).not.toContain('not for us');
    expect(sendGroup.mock.calls.map((call) => call[0])).toEqual([groupChatId]);

    const rows = await db.database
      .select({
        factValue: schema.familyMemoryFacts.factValue,
        memoryKind: schema.familyMemoryFacts.memoryKind,
        memorySource: schema.familyMemoryFacts.memorySource,
        validUntil: schema.familyMemoryFacts.validUntil,
      })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, familyId));
    const live = rows.filter((row) => row.validUntil === null);
    expect(live).toEqual([
      {
        factValue: 'not for us',
        memoryKind: 'lasting',
        memorySource: 'parent_message',
        validUntil: null,
      },
    ]);
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audits.map((row) => row.actionTaken)).toContain('memory_fact_retired');
  });

  it('promotes an inferred one-off after a booking signal and not before', async () => {
    const { familyId } = await seedSwim('one_off');
    const held = await promoteMatchingInferredFacts(db.database, {
      familyId,
      signal: 'booking',
      needle: 'Saturday swimming',
      now: NOW,
      env: {},
    });
    expect(held).toEqual({ promoted: 0, skipped: 'flag_off' });

    const promoted = await promoteMatchingInferredFacts(db.database, {
      familyId,
      signal: 'booking',
      needle: 'Saturday swimming',
      now: NOW,
      env: ON,
    });
    expect(promoted.promoted).toBe(1);

    const [row] = await db.database
      .select({
        memoryKind: schema.familyMemoryFacts.memoryKind,
        signalCount: schema.familyMemoryFacts.signalCount,
        validUntil: schema.familyMemoryFacts.validUntil,
      })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.familyId, familyId));
    expect(row).toMatchObject({ memoryKind: 'lasting', signalCount: 1, validUntil: null });
  });

  it('types the first inferred write as one_off and the repeat as lasting', async () => {
    const { familyId } = await seedFamily(db.database);
    const first = await memoryTypingForWrite(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'swimming',
      source: 'inferred',
      now: NOW,
      env: ON,
    });
    expect(first.memoryKind).toBe('one_off');
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'swimming',
      factValue: 'asked once',
      confidence: 0.9,
      inferredBy: 'chat_distiller',
      heard: 'unrecorded',
      validFrom: NOW,
      ...first,
    });
    const second = await memoryTypingForWrite(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'swimming',
      source: 'inferred',
      now: NOW,
      env: ON,
    });
    expect(second.memoryKind).toBe('lasting');
    expect(second.signalCount).toBe(1);
  });

  it('writes what do you know from the facts, and leaves teens and receipts out of them', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const teen = await seedChild(db.database, familyId, 'Noa', 170, undefined, NOW);
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'logistic',
      factKey: 'district',
      factValue: 'midtown',
      confidence: 1,
      inferredBy: 'ask-hale',
      heard: 'unrecorded',
      validFrom: new Date(NOW.getTime() - 2000),
      memoryKind: 'lasting',
      memorySource: 'parent_message',
      sourcedAt: new Date(NOW.getTime() - 2000),
      signalCount: 0,
    });
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'swimming',
      factValue: 'saturday',
      confidence: 0.9,
      inferredBy: 'memory_inferencer',
      heard: 'unrecorded',
      validFrom: NOW,
      memoryKind: 'one_off',
      memorySource: 'inferred',
      sourcedAt: NOW,
      signalCount: 0,
    });
    await writeFact(db.database, {
      familyId,
      childId: teen,
      factType: 'preference',
      factKey: 'teen_secret',
      factValue: 'SECRET_TEEN',
      confidence: 1,
      inferredBy: 'ask-hale',
      heard: 'unrecorded',
      validFrom: NOW,
      memoryKind: 'lasting',
      memorySource: 'parent_message',
      sourcedAt: NOW,
      signalCount: 0,
    });
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'logistic',
      factKey: 'health_checkpoint:week',
      factValue: 'done',
      confidence: 1,
      inferredBy: 'ask-hale',
      heard: 'unrecorded',
      validFrom: NOW,
      memoryKind: 'lasting',
      memorySource: 'receipt',
      sourcedAt: NOW,
      signalCount: 0,
    });
    const [inbound] = await db.database
      .insert(schema.channelMessages)
      .values({
        familyId,
        parentUserId,
        channel: 'imessage',
        direction: 'in',
        category: 'reply',
        status: 'delivered',
        providerChatId: `one-${familyId}`,
        inGroup: false,
      })
      .returning({ id: schema.channelMessages.id });
    const written = 'Here is what I remember: swimming, saturday (my guess), and midtown.';
    const client = scriptedReply({ text: written });
    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'what do you know about us?',
      now: NOW,
      inboundChannelMessageId: inbound?.id ?? null,
      env: LOCKED,
      replyClient: client,
      screen: LISTING,
    });
    // Every word is the model's; code hands it the facts with where each came from.
    expect(result).toMatchObject({ claimed: true, outcome: 'recalled', reply: written });
    const context = firstContext(client);
    expect(context.purpose).toBe('memory_list');
    expect([...context.facts].sort()).toEqual([
      'district: midtown (source: the parent told Hale; kept until they change it)',
      "swimming: saturday (source: Hale's own guess; seen once)",
    ]);
    const handed = JSON.stringify(context);
    expect(handed).not.toContain('SECRET_TEEN');
    expect(handed).not.toContain('Noa');
    expect(handed).not.toContain('health_checkpoint');
  });

  it('lists one-offs in recall and hides an expired temporary', async () => {
    const { familyId } = await seedFamily(db.database);
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'preference',
      factKey: 'swimming',
      factValue: 'once',
      confidence: 0.9,
      inferredBy: 'ask-hale',
      heard: 'unrecorded',
      validFrom: NOW,
      memoryKind: 'one_off',
      memorySource: 'inferred',
      sourcedAt: NOW,
      signalCount: 0,
    });
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'logistic',
      factKey: 'last_week',
      factValue: 'done',
      confidence: 1,
      inferredBy: 'ask-hale',
      heard: 'unrecorded',
      validFrom: NOW,
      memoryKind: 'temporary',
      memorySource: 'parent_message',
      sourcedAt: NOW,
      expiresAt: new Date(NOW.getTime() - 1000),
      signalCount: 0,
    });
    const recalled = await recallFamilyMemory(db.database, {
      familyId,
      now: NOW,
      reader: 'every_adult',
    });
    expect(recalled.map((row) => row.factKey)).toEqual(['swimming']);
    expect(recalled[0]).toMatchObject({ kind: 'one_off', source: 'inferred' });
  });

  it('does not touch the database when the handler flag is off', async () => {
    const database = new Proxy({} as TestDb['database'], {
      get() {
        throw new Error('flag off must not read');
      },
    });
    const verdict = await familyMemoryKindsHandler({}).handle(database, {
      familyId: '11111111-1111-4111-8111-111111111111',
      parentUserId: '22222222-2222-4222-8222-222222222222',
      conversationId: '33333333-3333-4333-8333-333333333333',
      body: 'forget swimming',
      now: NOW,
      send: async () => {
        throw new Error('flag off must not send');
      },
      resolved: null,
      openQuestions: async () => [],
      inboundChannelMessageId: null,
    });
    expect(verdict).toEqual({ claimed: false });
  });
});
