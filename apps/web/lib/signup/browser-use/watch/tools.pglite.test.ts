import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, type Skill, runAgent } from '@hale/agent';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  ADD_WATCH_TARGET_TOOL,
  LIST_WATCH_TARGETS_TOOL,
  REMOVE_WATCH_TARGET_TOOL,
  WATCH_TOOL_NAMES,
  augmentCoachSkillForProviderWatch,
  providerWatchTools,
  quotesParent,
} from './tools';

/**
 * The watch verbs driven by a MOCKED model (a scripted Anthropic client) through the real
 * agent loop and real DDL. The script stands in for the model's judgement of what the
 * parent meant; what is under test is what that judgement can and cannot reach. No key
 * is set and no request leaves the process.
 */
const NOW = new Date('2026-10-25T14:00:00.000Z');
const HOST = 'cityofx.perfectmind.com';

const SKILL: Skill = {
  meta: { name: 'watch-test', whenToUse: 'test', task: 'converse', tools: [...WATCH_TOOL_NAMES] },
  instructions: 'test',
};

const usage = { input_tokens: 10, output_tokens: 5 } as Anthropic.Usage;
const toolUse = (name: string, input: unknown): Anthropic.Message =>
  ({
    id: `m-${name}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [{ type: 'tool_use', id: `tu-${randomUUID()}`, name, input }],
    usage,
  }) as Anthropic.Message;
const done = (text: string): Anthropic.Message =>
  ({
    id: 'm-done',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text, citations: null }],
    usage,
  }) as Anthropic.Message;

function scripted(script: Anthropic.Message[]) {
  const results: unknown[] = [];
  let calls = 0;
  const client = {
    messages: {
      create: vi.fn(async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        const last = params.messages.at(-1);
        if (last && Array.isArray(last.content)) {
          for (const block of last.content) if (block.type === 'tool_result') results.push(block);
        }
        const msg = script[calls];
        calls += 1;
        if (!msg) throw new Error('script exhausted');
        return msg;
      }),
    },
  } as unknown as AgentClient;
  return { client, results };
}

describe('coach watch tools', () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  });
  afterAll(async () => {
    await db.close();
  });
  beforeEach(() => {
    for (const key of [
      'BROWSER_USE_API_KEY',
      'ANTHROPIC_API_KEY',
      'AI_GATEWAY_API_KEY',
      'LINQ_API_KEY',
    ]) {
      vi.stubEnv(key, '');
    }
  });

  async function familyWithBooking() {
    const fam = await seedFamily(db.database);
    const [booking] = await db.database
      .insert(schema.activityBookings)
      .values({
        familyId: fam.familyId,
        parentUserId: fam.parentUserId,
        integrationId: randomUUID(),
        messageId: `msg-${randomUUID()}`,
        providerHost: HOST,
        title: 'Preschool Swim',
        firstSessionAt: NOW,
      })
      .returning({ id: schema.activityBookings.id });
    if (!booking) throw new Error('no booking');
    return { ...fam, sourceRef: `booking:${booking.id}` };
  }

  async function turn(
    fam: { familyId: string; parentUserId: string },
    parentWords: string,
    script: Anthropic.Message[],
    toolFamilyId = fam.familyId,
  ) {
    const { client, results } = scripted(script);
    const tools = providerWatchTools({
      database: db.database,
      familyId: fam.familyId,
      parentUserId: fam.parentUserId,
      conversationId: 'conv-1',
      parentWords,
      linksThisTurn: () => [],
    });
    await runAgent({
      skill: SKILL,
      context: { parentWords },
      tools,
      client,
      maxSteps: 6,
      toolContext: { familyId: toolFamilyId, actor: fam.parentUserId },
      guardDeps: { writeAudit: async () => {} },
    });
    return results as Array<{ content: unknown; is_error?: boolean }>;
  }

  async function subscriptions(familyId: string) {
    return db.database
      .select()
      .from(schema.familyWatchSubscriptions)
      .where(eq(schema.familyWatchSubscriptions.familyId, familyId));
  }

  const asks = [
    {
      lang: 'English',
      words: 'Can you keep an eye on the swim waitlist at the city pool for me?',
      quote: 'keep an eye on the swim waitlist',
    },
    {
      lang: 'Chinese',
      words: '可以帮我盯一下游泳课的候补名单吗？',
      quote: '帮我盯一下游泳课的候补名单',
    },
    {
      lang: 'Korean',
      words: '수영 수업 대기자 명단 좀 계속 확인해 줄래요?',
      quote: '대기자 명단 좀 계속 확인해 줄래요',
    },
  ];

  for (const ask of asks) {
    it(`adds a target when the parent asks in ${ask.lang}`, async () => {
      const fam = await familyWithBooking();
      const results = await turn(fam, ask.words, [
        toolUse(LIST_WATCH_TARGETS_TOOL, {}),
        toolUse(ADD_WATCH_TARGET_TOOL, {
          sourceRef: fam.sourceRef,
          kind: 'waitlist',
          parentAgreement: ask.quote,
        }),
        done('ok'),
      ]);
      expect(results.every((r) => !r.is_error)).toBe(true);
      // The list the model saw carries no URL.
      expect(JSON.stringify(results[0])).not.toContain('https://');
      const [sub] = await subscriptions(fam.familyId);
      expect(sub).toMatchObject({
        parentUserId: fam.parentUserId,
        sourceRef: fam.sourceRef,
        consentConversationId: 'conv-1',
        consentQuote: ask.quote,
        removedAt: null,
      });
      const [target] = await db.database
        .select()
        .from(schema.providerWatchTargets)
        .where(eq(schema.providerWatchTargets.id, sub!.targetId));
      expect(target).toMatchObject({
        sourceUrl: `https://${HOST}/`,
        kind: 'waitlist',
        enabled: true,
      });
    });
  }

  it('a proposal without the parent agreeing creates nothing', async () => {
    const fam = await familyWithBooking();
    const results = await turn(fam, 'What swim classes are on Saturday?', [
      toolUse(ADD_WATCH_TARGET_TOOL, {
        sourceRef: fam.sourceRef,
        kind: 'openings',
        parentAgreement: 'yes, watch it',
      }),
      done('Want me to keep checking that pool for openings?'),
    ]);
    expect(results[0]?.is_error).toBe(true);
    expect(await subscriptions(fam.familyId)).toEqual([]);
  });

  it('never takes a model-written URL, and never acts for another family', async () => {
    const fam = await familyWithBooking();
    const words = 'yes please watch the pool for openings';
    const results = await turn(fam, words, [
      toolUse(ADD_WATCH_TARGET_TOOL, {
        sourceRef: 'https://made-up.example/page',
        kind: 'openings',
        parentAgreement: 'yes please watch the pool',
      }),
      done('ok'),
    ]);
    expect(results[0]?.is_error).toBe(true);
    const other = await seedFamily(db.database, 'Other');
    const scoped = await turn(
      fam,
      words,
      [
        toolUse(ADD_WATCH_TARGET_TOOL, {
          sourceRef: fam.sourceRef,
          kind: 'openings',
          parentAgreement: 'yes please watch the pool',
        }),
        done('ok'),
      ],
      other.familyId,
    );
    expect(scoped[0]?.is_error).toBe(true);
    expect(await subscriptions(fam.familyId)).toEqual([]);
  });

  it('turns a watch off when the parent says so in plain words', async () => {
    const fam = await familyWithBooking();
    await turn(fam, 'please watch the swim waitlist', [
      toolUse(ADD_WATCH_TARGET_TOOL, {
        sourceRef: fam.sourceRef,
        kind: 'schedule',
        parentAgreement: 'please watch the swim waitlist',
      }),
      done('ok'),
    ]);
    const [sub] = await subscriptions(fam.familyId);
    const results = await turn(fam, "we got in, you don't need to check the pool anymore", [
      toolUse(LIST_WATCH_TARGETS_TOOL, {}),
      toolUse(REMOVE_WATCH_TARGET_TOOL, { watchId: sub!.id }),
      done('ok'),
    ]);
    expect(results.every((r) => !r.is_error)).toBe(true);
    const [after] = await subscriptions(fam.familyId);
    expect(after?.removedAt).not.toBeNull();
    const [target] = await db.database
      .select()
      .from(schema.providerWatchTargets)
      .where(eq(schema.providerWatchTargets.id, sub!.targetId));
    // No other family is on this page and kind, so the sweep stops reading it.
    expect(target?.enabled).toBe(false);
  });

  it('keeps a page another family still watches when one family turns it off', async () => {
    const first = await familyWithBooking();
    const second = await familyWithBooking();
    for (const fam of [first, second]) {
      await turn(fam, 'please track openings at the pool', [
        toolUse(ADD_WATCH_TARGET_TOOL, {
          sourceRef: fam.sourceRef,
          kind: 'openings',
          parentAgreement: 'track openings at the pool',
        }),
        done('ok'),
      ]);
    }
    const [sub] = await subscriptions(first.familyId);
    await turn(first, 'stop that', [
      toolUse(REMOVE_WATCH_TARGET_TOOL, { watchId: sub!.id }),
      done('ok'),
    ]);
    const [target] = await db.database
      .select()
      .from(schema.providerWatchTargets)
      .where(eq(schema.providerWatchTargets.id, sub!.targetId));
    expect(target?.enabled).toBe(true);
    // And the second family cannot remove the first family's watch.
    const [mine] = await subscriptions(second.familyId);
    const results = await turn(second, 'stop', [
      toolUse(REMOVE_WATCH_TARGET_TOOL, { watchId: sub!.id }),
      done('ok'),
    ]);
    expect(results[0]?.is_error).toBe(true);
    expect(mine?.removedAt).toBeNull();
  });

  it('matches the quote by containment only, across width, case and spacing', () => {
    expect(quotesParent('Please  WATCH the pool', 'please watch')).toBe(true);
    expect(quotesParent('可以帮我盯一下', '帮我盯')).toBe(true);
    expect(quotesParent('what is on saturday', 'yes')).toBe(false);
    expect(quotesParent('anything', '   ')).toBe(false);
  });

  it('leaves the coach skill untouched with the flag off', () => {
    const skill: Skill = { ...SKILL, meta: { ...SKILL.meta, tools: ['lookup_week'] } };
    expect(augmentCoachSkillForProviderWatch(skill, false)).toBe(skill);
    expect(augmentCoachSkillForProviderWatch(skill, true).meta.tools).toEqual([
      'lookup_week',
      ...WATCH_TOOL_NAMES,
    ]);
  });
});
