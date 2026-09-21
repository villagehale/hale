import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient, Skill } from '@hale/agent';
import { schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadCronSkill } from '~/lib/cron/skill';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import {
  ASIDE_DEADLINE_MS,
  type ComposeAsideInput,
  type VoicePassDeps,
  createVoicePass,
  priorAlertsForAside,
} from './compose';
import { VOICE_PASS_LANES_ENV } from './flag';

/**
 * EVERY `NoAside` REACHED, AND THE BODY UNCHANGED IN ALL OF THEM.
 *
 * The composer's contract is that a refusal costs a parent nothing: the lane sends the
 * deterministic sentence it was always going to send. So every case below asserts the
 * outcome AND that nothing was assembled — an outcome union nobody checks the body
 * against is a promise, not a guarantee.
 *
 * The scripted client is the send-mechanics fake this repo already documents (rule #8
 * covers agent QUALITY, which is `eval:alert-aside`'s job against real cached Claude).
 * Here it drives the plumbing: which outcome, which row, which log line.
 */

const CORE = 'Riverside Pool cancelled Sunday swim class - it was Sunday, Sep 20 at 9:00 a.m.';
/** The sender and the title the log lines must never carry. */
const SENDER = 'Riverside Pool';
const TITLE = 'Sunday swim class';

let db: TestDb;
let familyId: string;
let skill: Skill;

beforeAll(async () => {
  db = await createTestDb();
  familyId = (await seedFamily(db.database)).familyId;
  skill = await loadCronSkill('alert-aside');
}, 60_000);

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env[VOICE_PASS_LANES_ENV];
  await db.database.delete(schema.agentRuns);
});

function input(over: Partial<ComposeAsideInput> = {}): ComposeAsideInput {
  return {
    familyId,
    lane: 'email_alert',
    core: CORE,
    teenContent: false,
    priorAlertsToHousehold24h: null,
    matchedAKnownOccasion: false,
    ctaSuffix: null,
    ...over,
  };
}

function toolMessage(clause: string, place: 'before' | 'after'): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'tool_use', id: 't1', name: 'aside', input: { clause, place } }],
    usage: { input_tokens: 1300, output_tokens: 12 },
  } as unknown as Anthropic.Message;
}

interface Scripted {
  client: AgentClient;
  calls: number;
}

function scripted(answer: () => Promise<Anthropic.Message>): Scripted {
  const s: Scripted = {
    calls: 0,
    client: {
      messages: {
        create: async () => {
          s.calls += 1;
          return await answer();
        },
      },
    } as unknown as AgentClient,
  };
  return s;
}

function deps(over: Partial<VoicePassDeps> = {}): VoicePassDeps {
  return {
    database: db.database,
    client: () => scripted(async () => toolMessage('', 'before')).client,
    loadSkill: async () => skill,
    ...over,
  };
}

async function agentRuns() {
  return await db.database
    .select()
    .from(schema.agentRuns)
    .where(and(eq(schema.agentRuns.familyId, familyId), eq(schema.agentRuns.agentName, 'voice-pass')));
}

describe('the four outcomes that never call the model', () => {
  it('lane_dark when the flag does not name this lane, and no client is even resolved', async () => {
    let resolved = 0;
    const pass = createVoicePass(
      deps({
        client: () => {
          resolved += 1;
          return scripted(async () => toolMessage('Third one in the last day.', 'before')).client;
        },
      }),
    );
    expect(await pass.compose(input())).toEqual({
      status: 'no_aside',
      reason: 'lane_dark',
      refusals: [],
    });
    expect(resolved).toBe(0);
    expect(await agentRuns()).toHaveLength(0);
  });

  it('teen_redacted without calling the model at all (rule #1)', async () => {
    process.env[VOICE_PASS_LANES_ENV] = 'email_alert';
    const client = scripted(async () => toolMessage('Third one in the last day.', 'before'));
    const pass = createVoicePass(deps({ client: () => client.client }));
    expect(await pass.compose(input({ teenContent: true }))).toEqual({
      status: 'no_aside',
      reason: 'teen_redacted',
      refusals: [],
    });
    expect(client.calls).toBe(0);
    expect(await agentRuns()).toHaveLength(0);
  });

  it('client_unavailable when the shared voice kill switch answers null', async () => {
    process.env[VOICE_PASS_LANES_ENV] = 'email_alert';
    const pass = createVoicePass(deps({ client: () => null }));
    expect(await pass.compose(input())).toEqual({
      status: 'no_aside',
      reason: 'client_unavailable',
      refusals: [],
    });
    expect(await agentRuns()).toHaveLength(0);
  });

  it('skill_unavailable when the skill does not load - a deploy bug, and it looks like one', async () => {
    process.env[VOICE_PASS_LANES_ENV] = 'email_alert';
    const client = scripted(async () => toolMessage('Third one in the last day.', 'before'));
    const pass = createVoicePass(
      deps({
        client: () => client.client,
        loadSkill: async () => {
          throw new Error('ENOENT alert-aside.md');
        },
      }),
    );
    expect(await pass.compose(input())).toEqual({
      status: 'no_aside',
      reason: 'skill_unavailable',
      refusals: [],
    });
    expect(client.calls).toBe(0);
    expect(await agentRuns()).toHaveLength(0);
  });
});

describe('the three outcomes that do call the model', () => {
  it('empty is the right answer, and it is completed rather than failed', async () => {
    process.env[VOICE_PASS_LANES_ENV] = 'email_alert';
    const pass = createVoicePass(
      deps({ client: () => scripted(async () => toolMessage('', 'before')).client }),
    );
    expect(await pass.compose(input())).toEqual({
      status: 'no_aside',
      reason: 'empty',
      refusals: [],
    });
    const rows = await agentRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('completed');
  });

  it('refused carries the guard own names, and the body is never assembled', async () => {
    process.env[VOICE_PASS_LANES_ENV] = 'email_alert';
    const pass = createVoicePass(
      deps({
        client: () =>
          scripted(async () => toolMessage('Say the word and it goes on your week.', 'before'))
            .client,
      }),
    );
    expect(await pass.compose(input())).toEqual({
      status: 'no_aside',
      reason: 'refused',
      refusals: ['solicits_reply', 'addresses_the_parent'],
    });
    expect((await agentRuns())[0]?.status).toBe('failed');
  });

  it('model_failed when the call throws', async () => {
    process.env[VOICE_PASS_LANES_ENV] = 'email_alert';
    const pass = createVoicePass(
      deps({
        client: () =>
          scripted(async () => {
            throw new Error('anthropic 529');
          }).client,
      }),
    );
    expect(await pass.compose(input())).toEqual({
      status: 'no_aside',
      reason: 'model_failed',
      refusals: [],
    });
    expect((await agentRuns())[0]?.status).toBe('failed');
  });

  it('assembles the core when the clause survives the guard', async () => {
    process.env[VOICE_PASS_LANES_ENV] = 'email_alert';
    const pass = createVoicePass(
      deps({
        client: () =>
          scripted(async () => toolMessage('Third one in the last day.', 'before')).client,
      }),
    );
    const outcome = await pass.compose(input({ priorAlertsToHousehold24h: 2 }));
    expect(outcome).toEqual({
      status: 'aside',
      body: `Third one in the last day. ${CORE}`,
    });
    // The whole point of the shape: the core is in there, byte for byte.
    if (outcome.status === 'aside') expect(outcome.body).toContain(CORE);
    const rows = await agentRuns();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('completed');
    expect(rows[0]?.modelUsed).toContain('haiku');
    expect(Number(rows[0]?.costUsd)).toBeGreaterThan(0);
    expect(rows[0]?.promptTokens).toBe(1300);
  });
});

describe('the body every no_aside returns', () => {
  it('is the core, byte for byte, in all seven', async () => {
    // The union with no body assertion behind it is a promise rather than a guarantee.
    // Every one of these must leave the lane's `message` exactly as it found it, which is
    // expressed here as: nothing but `status: 'aside'` ever carries a body at all.
    const cases: Array<[string, Partial<VoicePassDeps>, Partial<ComposeAsideInput>, string]> = [
      ['lane_dark', {}, {}, ''],
      ['teen_redacted', {}, { teenContent: true }, 'email_alert'],
      ['client_unavailable', { client: () => null }, {}, 'email_alert'],
      [
        'skill_unavailable',
        {
          loadSkill: async () => {
            throw new Error('nope');
          },
        },
        {},
        'email_alert',
      ],
      [
        'model_failed',
        {
          client: () =>
            scripted(async () => {
              throw new Error('boom');
            }).client,
        },
        {},
        'email_alert',
      ],
      [
        'empty',
        { client: () => scripted(async () => toolMessage('', 'after')).client },
        {},
        'email_alert',
      ],
      [
        'refused',
        { client: () => scripted(async () => toolMessage('Sounds good either way.', 'before')).client },
        {},
        'email_alert',
      ],
    ];
    for (const [reason, over, ctx, flag] of cases) {
      if (flag === '') delete process.env[VOICE_PASS_LANES_ENV];
      else process.env[VOICE_PASS_LANES_ENV] = flag;
      const outcome = await createVoicePass(deps(over)).compose(input(ctx));
      expect(outcome.status, reason).toBe('no_aside');
      expect(outcome, reason).not.toHaveProperty('body');
      if (outcome.status === 'no_aside') expect(outcome.reason).toBe(reason);
    }
  });
});

describe('the deadline', () => {
  it('treats its own eight seconds as model_failed, and answers inside them', async () => {
    process.env[VOICE_PASS_LANES_ENV] = 'email_alert';
    vi.useFakeTimers();
    try {
      const pass = createVoicePass(
        deps({ client: () => scripted(() => new Promise<never>(() => {})).client }),
      );
      const pending = pass.compose(input());
      await vi.advanceTimersByTimeAsync(ASIDE_DEADLINE_MS + 1);
      expect(await pending).toEqual({
        status: 'no_aside',
        reason: 'model_failed',
        refusals: [],
      });
    } finally {
      vi.useRealTimers();
    }
    // The attempt REACHED the model, so it is on the bill even though nothing came back.
    expect((await agentRuns())[0]?.status).toBe('failed');
  });
});

describe('plainText runs before the guard', () => {
  it('strips the markdown a phone would otherwise be sent', async () => {
    process.env[VOICE_PASS_LANES_ENV] = 'email_alert';
    const pass = createVoicePass(
      deps({
        client: () =>
          scripted(async () => toolMessage('**Third** one in the last day.', 'before')).client,
      }),
    );
    const outcome = await pass.compose(input({ priorAlertsToHousehold24h: 2 }));
    expect(outcome).toEqual({
      status: 'aside',
      body: `Third one in the last day. ${CORE}`,
    });
    // The mutation this exists for: skip the plainText call and the asterisks ship. The
    // guard cannot catch them - `*` is a GSM-7 basic character - so the check lives here
    // or nowhere.
    if (outcome.status === 'aside') expect(outcome.body).not.toContain('*');
  });
});

describe('the log carries no content (rule #1)', () => {
  it('names the error CLASS on model_failed, never the message it came with', async () => {
    process.env[VOICE_PASS_LANES_ENV] = 'email_alert';
    const captured: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => {
      captured.push(args);
    });
    const pass = createVoicePass(
      deps({
        client: () =>
          scripted(async () => {
            // A provider 4xx echoes the request, and the request carries the core.
            throw new Error(`400 invalid_request: system=... ${SENDER} ${TITLE}`);
          }).client,
      }),
    );
    await pass.compose(input());
    const line = JSON.stringify(captured);
    expect(line).not.toContain(SENDER);
    expect(line).not.toContain(TITLE);
    // The paired positive control. Without it this passes against a composer that logs
    // nothing at all, which is an absence test failing open.
    expect(line).toContain('Error');
    expect(line).toContain('email_alert');
  });

  it('names the refusal enums and the lane on refused, and never the clause', async () => {
    process.env[VOICE_PASS_LANES_ENV] = 'calendar_alert';
    const captured: unknown[][] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args) => {
      captured.push(args);
    });
    const pass = createVoicePass(
      deps({
        client: () =>
          scripted(async () => toolMessage('Say the word and it goes on your week.', 'after'))
            .client,
      }),
    );
    await pass.compose(input({ lane: 'calendar_alert' }));
    const line = JSON.stringify(captured);
    expect(line).not.toContain('Say the word');
    expect(line).not.toContain(SENDER);
    expect(line).toContain('solicits_reply');
    expect(line).toContain('calendar_alert');
  });
});

describe('priorAlertsForAside', () => {
  it('hands the count over only in the shape it is true of', () => {
    // A zero as a number is an invitation to say "the first one today", which is a claim
    // about a household's day dressed as an ordinal.
    expect(priorAlertsForAside(null)).toBeNull();
    expect(priorAlertsForAside(0)).toBeNull();
    expect(priorAlertsForAside(1)).toBe(1);
    expect(priorAlertsForAside(2)).toBe(2);
  });
});
