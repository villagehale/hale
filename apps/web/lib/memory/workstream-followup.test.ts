import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, type Skill, runAgent } from '@hale/agent';
import type { Database } from '@hale/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPT_OUT_LINE, OPT_OUT_SHORT } from '~/lib/channel/opt-out';
import type { OutboundGatePorts } from '~/lib/channel/outbound-gate';
import {
  composeWorkstreamFollowup,
  promisedPassedWeekday,
  runWorkstreamFollowupSweep,
} from './workstream-followup';
import { WORKSTREAMS_ENABLED_ENV, activeWorkstreamBlock } from './workstreams';

/** 11:00 in Toronto, 00:00 in Tokyo. Quiet hours are 21:00–08:00 local. */
const NOW = new Date('2026-08-12T15:00:00.000Z');
const FAMILY = '11111111-1111-4111-8111-111111111111';
const TITLE = 'Saturday swim for Sebastian near L7G';

function usage(): Anthropic.Usage {
  return {
    input_tokens: 8,
    output_tokens: 8,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
  };
}

function toolMessage(body: string): Anthropic.Message {
  return {
    id: 'msg-voice',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'tool_use', id: 'toolu_voice', name: 'write_followup', input: { body } }],
    usage: usage(),
  };
}

function gate(timeZone: string, sends = 0): OutboundGatePorts {
  return {
    channelEnrolled: async () => true,
    watchConsentGranted: async () => true,
    countProactiveSends: async () => sends,
    proactiveSentSince: async () => false,
    parentTimeZone: async () => timeZone,
  };
}

const due = {
  id: '22222222-2222-4222-8222-222222222222',
  familyId: FAMILY,
  title: TITLE,
  status: 'waiting_on_parent' as const,
  nextStep: 'parent has not picked',
  checkBackAt: new Date('2026-08-12T14:00:00.000Z'),
  childIds: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('workstream follow-up sweep', () => {
  it('does nothing, and reads nothing, unless the flag is exactly true', async () => {
    const listDue = vi.fn();
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true\n');
    const off = await runWorkstreamFollowupSweep({} as Database, { listDue });
    expect(off.enabled).toBe(false);
    expect(listDue).not.toHaveBeenCalled();

    const touched = {
      select: () => {
        throw new Error('touched');
      },
    } as unknown as Database;
    expect(await activeWorkstreamBlock(touched, FAMILY, NOW)).toBeNull();
  });

  it('holds a due check-back through quiet hours and does not compose', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const compose = vi.fn();
    const deliver = vi.fn();
    const result = await runWorkstreamFollowupSweep({} as Database, {
      now: () => NOW,
      listDue: async () => [due],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('Asia/Tokyo'),
      compose,
      deliver,
    });
    expect(result.held.quiet_hours).toBe(1);
    expect(result.sent).toBe(0);
    expect(compose).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('holds when the family already had a follow-up today', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const compose = vi.fn();
    const result = await runWorkstreamFollowupSweep({} as Database, {
      now: () => NOW,
      listDue: async () => [due],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('America/Toronto', 1),
      compose,
    });
    expect(result.held.frequency_cap).toBe(1);
    expect(compose).not.toHaveBeenCalled();
  });

  it('sends nothing and pages #ops when the model fails twice', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const pages: string[] = [];
    const deliver = vi.fn();
    const stamp = vi.fn(async () => undefined);
    const result = await runWorkstreamFollowupSweep({} as Database, {
      now: () => NOW,
      listDue: async () => [due],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('America/Toronto'),
      compose: async () => ({ ok: false, reason: 'model_failed' }),
      deliver,
      stamp,
      alreadyPaged: async () => false,
      noteUnsent: async () => undefined,
      page: async (text) => {
        pages.push(text);
      },
    });
    expect(result.skipped.compose_failed).toBe(1);
    expect(result.sent).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(pages).toEqual([`workstream followup unsent family=${FAMILY} reason=model_failed`]);
    expect(pages[0]).not.toContain(TITLE);
    expect(pages[0]).not.toContain('Sebastian');
  });

  it('stamps a declined check-back without paging #ops', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const page = vi.fn();
    const stamp = vi.fn(async () => undefined);
    const result = await runWorkstreamFollowupSweep({} as Database, {
      now: () => NOW,
      listDue: async () => [due],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('America/Toronto'),
      compose: async () => ({ ok: false, reason: 'empty' }),
      stamp,
      page,
    });
    expect(result.skipped.nothing_to_say).toBe(1);
    expect(stamp).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
  });

  it('does not back off a missing model client', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const stamp = vi.fn(async () => undefined);
    const page = vi.fn();
    const result = await runWorkstreamFollowupSweep({} as Database, {
      now: () => NOW,
      listDue: async () => [due],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('America/Toronto'),
      compose: async () => ({ ok: false, reason: 'not_configured' }),
      stamp,
      page,
    });
    expect(result.skipped.not_configured).toBe(1);
    expect(stamp).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
  });

  it('counts a group hold as that hold', async () => {
    vi.stubEnv(WORKSTREAMS_ENABLED_ENV, 'true');
    const result = await runWorkstreamFollowupSweep({} as Database, {
      now: () => NOW,
      listDue: async () => [due, { ...due, id: '33333333-3333-4333-8333-333333333333' }],
      f14: () => true,
      linkedTeen: async () => false,
      parentFor: async () => 'user-1',
      dedupeActive: async () => false,
      buildGate: () => gate('America/Toronto'),
      compose: async () => ({ ok: true, body: 'The camp has not written back.' }),
      resolvePhone: async () => '+14165550199',
      targetFor: async () => ({ channel: 'legacy' }),
      deliver: vi
        .fn()
        .mockResolvedValueOnce({ status: 'held', reason: 'group_cap' })
        .mockResolvedValueOnce({ status: 'held', reason: 'quiet_hours' }),
    });
    expect(result.held.group_cap).toBe(1);
    expect(result.held.quiet_hours).toBe(1);
    expect(result.held.frequency_cap).toBe(0);
    expect(result.sent).toBe(0);
  });
});

describe('workstream follow-up voice', () => {
  it('retries once and keeps the second sentence', async () => {
    const bodies = ['', 'Still holding that Saturday swim if you want to pick one.'];
    const client = {
      messages: {
        create: vi.fn(async () => toolMessage(bodies.shift() ?? '')),
      },
    } as unknown as AgentClient;
    const result = await composeWorkstreamFollowup({
      client,
      title: TITLE,
      status: 'waiting_on_parent',
      nextStep: 'parent has not picked',
    });
    expect(result).toEqual({
      ok: true,
      body: 'Still holding that Saturday swim if you want to pick one.',
    });
    expect(client.messages.create).toHaveBeenCalledTimes(2);
  });

  it('folds a French sentence the way the other French sends do', async () => {
    const client = {
      messages: {
        create: vi.fn(async () =>
          toolMessage('Le camp n’a pas encore répondu — je te le dis pour la fête.'),
        ),
      },
    } as unknown as AgentClient;
    const result = await composeWorkstreamFollowup({
      client,
      title: 'inscription au camp',
      status: 'waiting_on_third_party',
      nextStep: 'le camp n’a pas écrit',
      now: NOW,
      timeZone: 'America/Toronto',
      language: 'fr',
    });
    expect(result).toEqual({
      ok: true,
      body: "Le camp n'a pas encore répondu - je te le dis pour la fete.",
    });
  });

  it('rejects a stock opener and a weekday that is already today', async () => {
    const thursday = new Date('2026-08-13T15:00:00.000Z');
    const bodies = [
      'Just checking in on the swim.',
      "I'll follow up with them Thursday.",
      'The camp still has not written back.',
    ];
    const seen: string[] = [];
    const client = {
      messages: {
        create: vi.fn(async (params: { messages?: Array<{ content?: unknown }> }) => {
          const content = params.messages?.[0]?.content;
          if (typeof content === 'string') seen.push(content);
          return toolMessage(bodies.shift() ?? '');
        }),
      },
    } as unknown as AgentClient;
    const result = await composeWorkstreamFollowup({
      client,
      title: 'camp spot',
      status: 'waiting_on_third_party',
      nextStep: 'waiting on the camp',
      now: thursday,
      timeZone: 'America/Toronto',
      language: 'en',
    });
    expect(result).toEqual({ ok: false, reason: 'past_weekday' });
    expect(seen[0]).toContain('whose_move: third_party');
    expect(seen[0]).toContain('today: 2026-08-13');
    expect(seen[0]).toContain('language: en');
    expect(seen[1]).toContain('previous attempt refused: stock_opener');
    expect(seen[2]).toBeUndefined();
  });

  it('returns no sentence when both attempts fail', async () => {
    const bodies = [OPT_OUT_LINE, `check back. ${OPT_OUT_SHORT}`];
    const client = {
      messages: {
        create: vi.fn(async () => toolMessage(bodies.shift() ?? '')),
      },
    } as unknown as AgentClient;
    const result = await composeWorkstreamFollowup({
      client,
      title: TITLE,
      status: 'waiting_on_parent',
      nextStep: null,
    });
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('body');
  });

  it('keeps canned opt-out lines out of the composer and the skill', () => {
    const composer = readFileSync(
      fileURLToPath(new URL('./workstream-followup.ts', import.meta.url)),
      'utf8',
    );
    const skill = readFileSync(
      fileURLToPath(
        new URL('../../../../packages/agent/skills/workstream-followup.md', import.meta.url),
      ),
      'utf8',
    );
    for (const banned of ['Reply YES', 'Reply STOP', 'STOP to opt out', 'Plain ASCII']) {
      expect(composer).not.toContain(banned);
      expect(skill).not.toContain(banned);
    }
    expect(skill).toContain('whose_move');
    expect(skill).toContain('empty body');
  });

  it('treats a promised weekday that has passed as past, and a later one as still ahead', () => {
    const thursday = new Date('2026-08-13T15:00:00.000Z');
    const zone = 'America/Toronto';
    expect(promisedPassedWeekday("I'll follow up with them Thursday", thursday, zone)).toBe(true);
    expect(promisedPassedWeekday("I'll follow up with them Friday", thursday, zone)).toBe(false);
    expect(promisedPassedWeekday("I'll follow up next Thursday", thursday, zone)).toBe(false);
    expect(promisedPassedWeekday('The camp said Thursday', thursday, zone)).toBe(false);
    expect(promisedPassedWeekday('Je vais leur écrire jeudi', thursday, zone)).toBe(true);
    expect(promisedPassedWeekday('Je vais écrire vendredi', thursday, zone)).toBe(false);
  });
});

describe('workstream prompt placement', () => {
  it('puts the open list on the user turn, after the cached skill prefix', async () => {
    const captured: Array<{
      system?: Anthropic.TextBlockParam[];
      messages?: Anthropic.MessageParam[];
    }> = [];
    const client = {
      messages: {
        create: async (params: {
          system?: Anthropic.TextBlockParam[];
          messages?: Anthropic.MessageParam[];
        }) => {
          captured.push(params);
          return {
            id: 'msg',
            type: 'message',
            role: 'assistant',
            model: 'claude',
            stop_reason: 'end_turn',
            stop_sequence: null,
            content: [{ type: 'text', text: 'Still on the swim.', citations: null }],
            usage: usage(),
          } as Anthropic.Message;
        },
      },
    } as unknown as AgentClient;
    const skill: Skill = {
      meta: { name: 'cache-probe', whenToUse: 'test', task: 'converse', tools: [] },
      instructions: 'static skill instructions',
    };
    await runAgent({
      skill,
      context: { memoryBrief: { text: `active_workstreams:\ntitle=${TITLE}` } },
      tools: [],
      client,
      maxSteps: 1,
      toolContext: { familyId: FAMILY, actor: 'system' },
      guardDeps: { writeAudit: async () => undefined },
      maxTokens: 64,
    });
    const system = JSON.stringify(captured[0]?.system);
    const user = JSON.stringify(captured[0]?.messages?.[0]?.content);
    expect(system).toContain('static skill instructions');
    expect(system).toContain('ephemeral');
    expect(system).not.toContain(TITLE);
    expect(user).toContain(TITLE);
  });
});
