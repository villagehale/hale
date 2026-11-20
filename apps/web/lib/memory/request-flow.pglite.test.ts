import type { AgentClient } from '@hale/agent';
import { schema } from '@hale/db';
import { factsForContext } from '@hale/worker/memory-context';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { HandlerContext } from '~/lib/channel/router/route';
import { type TestDb, createTestDb, seedChild, seedFamily } from '~/lib/testing/pglite';
import { writeFact } from './facts';
import { FORGOTTEN_HOLD_MS, MEMORY_FACT_FORGOTTEN, parentForgotRecently } from './forget';
import { familyMemoryKindsHandler } from './handler';
import {
  type MemoryScreenScript,
  asked,
  refsFor,
  scriptedMemoryScreen,
} from './scripted-memory-screen.fixture';
import { handleParentMemory } from './store';

/**
 * VIL-723 · "what do you know about us", "forget X" and "correct X" are the model's
 * meaning read, never a phrase match, and every reply is the model's from the facts.
 *
 * The meaning screen is scripted per test (a stand-in at its port): what the model makes
 * of real wording in English, French and Chinese is the meaning-screen eval's job
 * (rule #8). These tests hold what code does around the read: what is claimed, which
 * facts the read and the writer are shown, what is retired, what is audited, and that a
 * group never hears the list.
 */

const NOW = new Date('2026-11-20T15:00:00.000Z');
const ON = { FAMILY_MEMORY_KINDS_ENABLED: 'true' };

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function belief(familyId: string, factKey: string, factValue: string, childId?: string) {
  const written = await writeFact(db.database, {
    familyId,
    childId: childId ?? null,
    factType: 'preference',
    factKey,
    factValue,
    confidence: 0.9,
    inferredBy: 'memory_inferencer',
    heard: 'unrecorded',
    validFrom: NOW,
    memoryKind: 'lasting',
    memorySource: 'inferred',
    sourcedAt: NOW,
    signalCount: 0,
  });
  return written.factId;
}

async function inbound(familyId: string, parentUserId: string, inGroup: boolean | null) {
  const [row] = await db.database
    .insert(schema.channelMessages)
    .values({
      familyId,
      parentUserId,
      channel: 'imessage',
      direction: 'in',
      category: 'reply',
      status: 'delivered',
      providerChatId: inGroup ? `group-${familyId}` : `one-${familyId}`,
      inGroup,
    })
    .returning({ id: schema.channelMessages.id });
  if (!row) throw new Error('inbound insert returned no row');
  return row.id;
}

/** The model at its client port: records the context it was handed, answers `text`. */
function writer(text: string): AgentClient & { contexts: Array<Record<string, unknown>> } {
  const contexts: Array<Record<string, unknown>> = [];
  return {
    contexts,
    messages: {
      create: vi.fn(async (request: { messages: Array<{ content: unknown }> }) => {
        const first = request.messages[0]?.content;
        const raw =
          typeof first === 'string'
            ? first
            : ((first as Array<{ type: string; text?: string }>).find((b) => b.type === 'text')
                ?.text ?? '{}');
        contexts.push(JSON.parse(raw) as Record<string, unknown>);
        return {
          content: [{ type: 'text', text: JSON.stringify({ text }) }],
          usage: { input_tokens: 12, output_tokens: 8 },
          stop_reason: 'end_turn',
        };
      }),
    },
  } as unknown as AgentClient & { contexts: Array<Record<string, unknown>> };
}

function turn(familyId: string, parentUserId: string, body: string, inboundId: string | null) {
  return {
    familyId,
    parentUserId,
    conversationId: '33333333-3333-4333-8333-333333333333',
    body,
    now: NOW,
    send: async () => {
      throw new Error('the memory handler answers through its verdict');
    },
    resolved: null,
    openQuestions: async () => [],
    inboundChannelMessageId: inboundId,
  } as unknown as HandlerContext;
}

const NO_READ: MemoryScreenScript = {
  request: () => {
    throw new Error('the flag is off: the screen is never asked');
  },
};

describe('the handler claims a memory request only on the model read, and only while lit', () => {
  it('flag off: no read, no claim, no detect', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const screen = scriptedMemoryScreen(NO_READ);
    const handler = familyMemoryKindsHandler({}, { screen });
    const ctx = turn(familyId, parentUserId, 'what do you know about us?', null);
    expect(await handler.handle(db.database, ctx)).toEqual({ claimed: false });
    expect(await handler.detects(db.database, ctx)).toBe(false);
    for (const near of ['TRUE', 'true\n', 'on']) {
      const dark = familyMemoryKindsHandler({ FAMILY_MEMORY_KINDS_ENABLED: near }, { screen });
      expect(await dark.handle(db.database, ctx)).toEqual({ claimed: false });
    }
    expect(screen.calls).toEqual([]);
  });

  it('lit: claims what the screen reads as list, forget or correct, in any language, and nothing else', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await belief(familyId, 'swimming', 'saturday class');
    const paraphrases: Array<[string, ReturnType<typeof asked> | null]> = [
      ['what have you got on file about us?', asked('list')],
      ['tu te souviens de quoi pour notre famille ?', asked('list', { language: 'fr' })],
      ['你都记得我们家哪些事？', asked('list', { language: 'zh' })],
      ["please don't keep the swim thing", asked('forget', { target: 'the swim thing' })],
      ['oublie la natation', asked('forget', { target: 'la natation', language: 'fr' })],
      ['把游泳课那条忘掉吧', asked('forget', { target: '游泳课', language: 'zh' })],
      ['no, swim moved to thursdays', asked('correct', { target: 'swim', value: 'thursdays' })],
      [
        'la natation, c’est le jeudi maintenant',
        asked('correct', { target: 'la natation', value: 'le jeudi', language: 'fr' }),
      ],
      ['游泳课改到周四了', asked('correct', { target: '游泳课', value: '周四', language: 'zh' })],
    ];
    const unrelated = [
      'what time is swim tomorrow?',
      'forget it, I will book it myself',
      'oublie ça, on verra demain',
    ];
    const byText = new Map(paraphrases);
    const screen = scriptedMemoryScreen({
      request: (text) => byText.get(text) ?? { hit: false, memory: 'none' },
      target: (_text, facts) => ({ hit: true, refs: refsFor(facts, 'swimming'), value: 'x' }),
    });
    const handler = familyMemoryKindsHandler(ON, { screen });
    for (const [body] of paraphrases) {
      const id = await inbound(familyId, parentUserId, false);
      const verdict = await handler.handle(db.database, turn(familyId, parentUserId, body, id));
      expect(verdict.claimed, body).toBe(true);
      // Re-seed what a forget or a correction retired, so each paraphrase meets the fact.
      const live = await db.database
        .select({ id: schema.familyMemoryFacts.id })
        .from(schema.familyMemoryFacts)
        .where(
          and(
            eq(schema.familyMemoryFacts.familyId, familyId),
            eq(schema.familyMemoryFacts.factKey, 'swimming'),
            isNull(schema.familyMemoryFacts.validUntil),
          ),
        );
      if (live.length === 0) await belief(familyId, 'swimming', 'saturday class');
    }
    for (const body of unrelated) {
      const ctx = turn(familyId, parentUserId, body, await inbound(familyId, parentUserId, false));
      expect(await handler.handle(db.database, ctx), body).toEqual({ claimed: false });
      expect(await handler.detects(db.database, ctx), body).toBe(false);
    }
  });

  it('an unread screen claims nothing, and beside a running turn hands the text back', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const handler = familyMemoryKindsHandler(ON, {
      screen: scriptedMemoryScreen({ request: () => null }),
    });
    const ctx = turn(familyId, parentUserId, 'forget the swim thing', null);
    expect(await handler.handle(db.database, ctx)).toEqual({ claimed: false });
    expect(await handler.detects(db.database, ctx)).toBe(true);
  });
});

describe('a group never hears the list', () => {
  it('asked in a group, the list is written for the asker and goes to them alone', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await belief(familyId, 'swimming', 'saturday class');
    const handler = familyMemoryKindsHandler(ON, {
      screen: scriptedMemoryScreen({ request: () => asked('list') }),
    });
    const id = await inbound(familyId, parentUserId, true);
    // The reply client is the shared one; with no key configured it is absent, so the
    // verdict holds (nothing is sent anywhere). What matters is where it would go.
    const verdict = await handler.handle(
      db.database,
      turn(familyId, parentUserId, 'Hale, what do you know about us?', id),
    );
    expect(verdict).toMatchObject({ claimed: true, outcome: 'recalled', onlyToAsker: true });

    const client = writer('Here is what I remember: swimming, saturday class.');
    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'Hale, what do you know about us?',
      now: NOW,
      inboundChannelMessageId: await inbound(familyId, parentUserId, true),
      env: ON,
      replyClient: client,
      screen: scriptedMemoryScreen({ request: () => asked('list') }),
    });
    expect(result).toMatchObject({ outcome: 'recalled', onlyToAsker: true });
    expect(client.contexts[0]).toMatchObject({ purpose: 'memory_list', audience: 'direct' });
  });

  it('a turn nobody can place gets no value at all, and asks for the 1:1', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await belief(familyId, 'swimming', 'saturday class');
    const client = writer('That list is yours in our own thread, just text me there.');
    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'what do you know about us?',
      now: NOW,
      inboundChannelMessageId: await inbound(familyId, parentUserId, null),
      env: ON,
      replyClient: client,
      screen: scriptedMemoryScreen({ request: () => asked('list') }),
    });
    expect(result).toMatchObject({ claimed: true, outcome: 'recall_withheld', onlyToAsker: false });
    expect(client.contexts[0]).toMatchObject({
      purpose: 'memory_list_private',
      audience: 'group',
      facts: [],
    });
  });
});

describe('forget retires the fact from what Hale uses, and audits it', () => {
  it('retires it, writes the audit row, and drops it from the coach context', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const factId = await belief(familyId, 'swimming', 'saturday class');
    await belief(familyId, 'district', 'midtown');
    const client = writer('Done, swimming is gone from what I keep.');
    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'please stop remembering the swim class',
      now: NOW,
      inboundChannelMessageId: await inbound(familyId, parentUserId, false),
      env: ON,
      replyClient: client,
      screen: scriptedMemoryScreen({
        request: () => asked('forget', { target: 'the swim class' }),
        target: (_text, facts) => ({ hit: true, refs: refsFor(facts, 'swimming') }),
      }),
    });
    expect(result).toMatchObject({ claimed: true, outcome: 'forgotten', forgotten: 1 });
    expect(result.reply).toBe('Done, swimming is gone from what I keep.');
    expect(client.contexts[0]).toMatchObject({
      purpose: 'memory_forgotten',
      facts: ['forgotten: swimming: saturday class'],
    });

    const [row] = await db.database
      .select({ validUntil: schema.familyMemoryFacts.validUntil })
      .from(schema.familyMemoryFacts)
      .where(eq(schema.familyMemoryFacts.id, factId));
    expect(row?.validUntil).not.toBeNull();
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken, targetId: schema.auditLog.targetId })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audits).toContainEqual({ actionTaken: MEMORY_FACT_FORGOTTEN, targetId: factId });

    const context = await factsForContext(db.database, familyId, {
      now: NOW,
      reader: 'every_adult',
      limit: 20,
    });
    expect(context.map((fact) => fact.factKey)).toEqual(['district']);
  });

  it('a record Hale keeps is answered as kept, and nothing is retired', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'logistic',
      factKey: 'weekday_care',
      factValue: 'Little Sprouts',
      confidence: 1,
      inferredBy: 'weekday-care-reply',
      heard: 'unrecorded',
      validFrom: NOW,
    });
    const client = writer('That one stays, it is part of the care record.');
    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'forget the daycare',
      now: NOW,
      inboundChannelMessageId: await inbound(familyId, parentUserId, false),
      env: ON,
      replyClient: client,
      screen: scriptedMemoryScreen({
        request: () => asked('forget', { target: 'the daycare' }),
        target: (_text, facts) => ({ hit: true, refs: refsFor(facts, 'weekday_care') }),
      }),
    });
    expect(result).toMatchObject({ claimed: true, outcome: 'refused', forgotten: 0 });
    expect(client.contexts[0]).toMatchObject({ purpose: 'memory_forget_kept' });
    const live = await db.database
      .select({ id: schema.familyMemoryFacts.id })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, familyId),
          isNull(schema.familyMemoryFacts.validUntil),
        ),
      );
    expect(live).toHaveLength(1);
  });

  it('an unread target acts on nothing and sends nothing', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await belief(familyId, 'swimming', 'saturday class');
    const client = writer('should never be asked');
    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'forget the swim thing',
      now: NOW,
      inboundChannelMessageId: await inbound(familyId, parentUserId, false),
      env: ON,
      replyClient: client,
      screen: scriptedMemoryScreen({
        request: () => asked('forget', { target: 'the swim thing' }),
        target: () => null,
      }),
    });
    expect(result).toMatchObject({ claimed: true, outcome: 'target_unread', reply: null });
    expect(client.contexts).toEqual([]);
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audits).toEqual([]);
  });

  it('a 13+ child’s fact is never shown to the target read', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    const teen = await seedChild(db.database, familyId, 'Noa', 170, undefined, NOW);
    await belief(familyId, 'teen_secret', 'SECRET_TEEN', teen);
    await belief(familyId, 'swimming', 'saturday class');
    const screen = scriptedMemoryScreen({
      request: () => asked('forget', { target: 'it' }),
      target: () => ({ hit: false, refs: [] }),
    });
    await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'forget it',
      now: NOW,
      inboundChannelMessageId: await inbound(familyId, parentUserId, false),
      env: ON,
      replyClient: null,
      screen,
    });
    const shown = screen.calls.find((call) => call.screen === 'memory_target');
    expect(JSON.stringify(shown?.facts)).toContain('swimming');
    expect(JSON.stringify(shown?.facts)).not.toContain('SECRET_TEEN');
  });
});

describe('a reply the model did not write is held, never replaced', () => {
  it('sends nothing, names the outcome, and pages #ops once', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await belief(familyId, 'swimming', 'saturday class');
    // A model answer the production validator refuses: a digit no fact holds.
    const client = writer('I remember 3 things about your family.');
    const urgent = vi.spyOn(console, 'error');
    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'what do you know about us?',
      now: NOW,
      inboundChannelMessageId: await inbound(familyId, parentUserId, false),
      env: ON,
      replyClient: client,
      screen: scriptedMemoryScreen({ request: () => asked('list') }),
    });
    expect(result).toMatchObject({ claimed: true, outcome: 'recalled', reply: null });
    expect(client.contexts).toHaveLength(1);
    const audits = await db.database
      .select({ actionTaken: schema.auditLog.actionTaken })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.familyId, familyId));
    expect(audits.map((row) => row.actionTaken)).toContain('reply_copy_fallback');
    // pageOps' own body-free URGENT line: #ops is paged (Slack is not configured in tests,
    // so the post is named skipped and the hour's claim is released for the next one).
    const lines = urgent.mock.calls.map((call) => String(call[1] ?? call[0]));
    urgent.mockRestore();
    expect(lines).toContain('URGENT: memory_reply_unwritten - paging #ops');
  });
});

describe('a correction never overwrites another writer’s record', () => {
  it('refuses a key a duty row holds, and leaves the row alone', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await writeFact(db.database, {
      familyId,
      childId: null,
      factType: 'logistic',
      factKey: 'pickup_owner',
      factValue: 'dad',
      confidence: 1,
      inferredBy: 'coparent_duty',
      heard: 'unrecorded',
      validFrom: NOW,
    });
    const client = writer('That one stays as it is.');
    const result = await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'mom does pickup now',
      now: NOW,
      inboundChannelMessageId: await inbound(familyId, parentUserId, false),
      env: ON,
      replyClient: client,
      screen: scriptedMemoryScreen({
        request: () => asked('correct', { target: 'pickup', value: 'mom' }),
        // The read proposes a key rather than the shown row: code still refuses it.
        target: () => ({ hit: false, refs: [], value: 'mom', key: 'pickup_owner' }),
      }),
    });
    expect(result).toMatchObject({ claimed: true, outcome: 'refused', corrected: 0 });
    const live = await db.database
      .select({ factValue: schema.familyMemoryFacts.factValue })
      .from(schema.familyMemoryFacts)
      .where(
        and(
          eq(schema.familyMemoryFacts.familyId, familyId),
          isNull(schema.familyMemoryFacts.validUntil),
        ),
      );
    expect(live).toEqual([{ factValue: 'dad' }]);
  });
});

describe('a forgotten fact is not learned again overnight from the same words', () => {
  it('holds for the re-read window, only for a parent forget, and only while lit', async () => {
    const { familyId, parentUserId } = await seedFamily(db.database);
    await belief(familyId, 'swimming', 'saturday class');
    await handleParentMemory(db.database, {
      familyId,
      parentUserId,
      body: 'forget swim',
      now: NOW,
      inboundChannelMessageId: await inbound(familyId, parentUserId, false),
      env: ON,
      replyClient: null,
      screen: scriptedMemoryScreen({
        request: () => asked('forget', { target: 'swim' }),
        target: (_text, facts) => ({ hit: true, refs: refsFor(facts, 'swimming') }),
      }),
    });
    const ask = (factKey: string, now: Date, env: Record<string, string> = ON) =>
      parentForgotRecently(db.database, { familyId, childId: null, factKey, now, env });
    expect(await ask('swimming', new Date(NOW.getTime() + 60_000))).toBe(true);
    expect(await ask('swimming', new Date(NOW.getTime() + FORGOTTEN_HOLD_MS - 60_000))).toBe(true);
    expect(await ask('swimming', new Date(NOW.getTime() + FORGOTTEN_HOLD_MS + 60_000))).toBe(false);
    expect(await ask('district', new Date(NOW.getTime() + 60_000))).toBe(false);
    expect(await ask('swimming', new Date(NOW.getTime() + 60_000), {})).toBe(false);

    // A writer replacing a value is not a forget: the old row is superseded, not forgotten.
    const other = await seedFamily(db.database);
    await belief(other.familyId, 'swimming', 'saturday class');
    await belief(other.familyId, 'swimming', 'sunday class');
    expect(
      await parentForgotRecently(db.database, {
        familyId: other.familyId,
        childId: null,
        factKey: 'swimming',
        now: new Date(NOW.getTime() + 60_000),
        env: ON,
      }),
    ).toBe(false);
  });
});
