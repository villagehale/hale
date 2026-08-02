import type { RegisteredTool, Skill } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { type ChannelTurn, draftsFromFailure } from '~/lib/channel/router/coach-runtime';
import { smsSegments } from '~/lib/channel/sms-segments';
import { MAX_REPLY_SEGMENTS } from './reply';
import { type ChannelCoachPorts, channelCoachRuntime } from './runtime';

/**
 * The runtime, with every collaborator injected — the model included, because what is
 * asserted here is the PLUMBING around it: that the turn is grounded on the thread C1
 * already wrote, that the answer is post-processed before it leaves, that a run with no
 * answer is a THROWN failed turn rather than a soothing sentence, and that the run is
 * recorded either way.
 *
 * Whether the model picks the right tool and writes the right words is not asserted
 * here and could not be: that is rule #8's territory, measured against real cached
 * Claude in `apps/worker/evals/run-coach-channel-eval.mjs`.
 */

const FAMILY = '11111111-1111-4111-8111-111111111111';
const PARENT = '22222222-2222-4222-8222-222222222222';
const CONVERSATION = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-07-30T12:00:00.000Z');
const LINK = 'https://app.villagehale.com';

/** 16y at NOW → teenager, derived from the @hale/types boundary, not from output. */
const TEEN = { name: 'Nora', gender: 'girl', dateOfBirth: '2010-03-04' };

function turn(body = 'move swim to tuesday'): ChannelTurn {
  return { familyId: FAMILY, parentUserId: PARENT, conversationId: CONVERSATION, body, now: NOW };
}

const SKILL: Skill = {
  meta: { name: 'coach-channel-sms', whenToUse: 'x', task: 'converse', tools: [] },
  instructions: 'be terse',
};

function answering(answer: string | null, hitMaxSteps = false): ChannelCoachPorts['runAgent'] {
  return async () => ({
    answer,
    steps: 1,
    hitMaxSteps,
    usage: { promptTokens: 100, completionTokens: 20 },
  });
}

interface Recorded {
  agentName: string;
  status: string;
  latencyMs: number;
}

function ports(overrides: Partial<ChannelCoachPorts> = {}) {
  const recorded: Recorded[] = [];
  const contextInputs: unknown[] = [];
  const base: ChannelCoachPorts = {
    loadSkill: async () => SKILL,
    loadTranscript: async () => [{ role: 'user' as const, content: 'earlier' }],
    loadContext: async (input) => {
      contextInputs.push(input);
      return { question: input.question, transcript: input.transcript } as never;
    },
    loadChildren: async () => [TEEN],
    buildTools: () => [] as RegisteredTool[],
    guardDeps: { async writeAudit() {} },
    // Never reached: `runAgent` is injected below, and it is the only consumer.
    client: () => ({ messages: {} }) as never,
    runAgent: answering('Move swim to Tue 4:30? YES to confirm.'),
    recordRun: async (run) => {
      recorded.push({ agentName: run.agentName, status: run.status, latencyMs: run.latencyMs });
    },
    appLink: () => LINK,
    now: () => NOW,
    ...overrides,
  };
  return Object.assign(base, { recorded, contextInputs });
}

describe('channelCoachRuntime', () => {
  it('answers a turn with the post-processed reply', async () => {
    const { reply } = await channelCoachRuntime(ports()).respond(turn());

    expect(reply).toBe('Move swim to Tue 4:30? YES to confirm.');
  });

  /**
   * The turn is grounded on the thread rather than on the job: C1 has already appended
   * the parent's message, so the runtime reads the conversation and never re-states the
   * question into it. Nothing in {@link ChannelCoachPorts} can write to `messages` —
   * that is the structural half of the same guarantee.
   */
  it('grounds the model on the conversation C1 threaded, whole-family scope', async () => {
    const p = ports();

    await channelCoachRuntime(p).respond(turn('cancel swim'));

    expect(p.contextInputs).toEqual([
      expect.objectContaining({
        familyId: FAMILY,
        question: 'cancel swim',
        focusedChildId: null,
        transcript: [{ role: 'user', content: 'earlier' }],
      }),
    ]);
  });

  it('hands the loop the channel context: the surface, the app link, the family clock', async () => {
    const seen: unknown[] = [];
    const p = ports({
      runAgent: async (args) => {
        seen.push(args.context);
        return answering('ok.')(args);
      },
    });

    await channelCoachRuntime(p).respond(turn());

    expect(seen[0]).toEqual(
      expect.objectContaining({
        channel: 'sms',
        appLink: LINK,
        nowIso: NOW.toISOString(),
        question: 'move swim to tuesday',
      }),
    );
  });

  it("redacts a 13+ child's name out of the reply before returning it (rule #1)", async () => {
    const p = ports({ runAgent: answering('Nora has practice Thursday.') });

    const { reply } = await channelCoachRuntime(p).respond(turn());

    expect(reply).toBe('your kid has practice Thursday.');
  });

  it('holds a long answer to the segment budget', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} about swim.`).join(' ');
    const p = ports({ runAgent: answering(long) });

    const { reply } = await channelCoachRuntime(p).respond(turn());

    expect(smsSegments(reply)).toBeLessThanOrEqual(MAX_REPLY_SEGMENTS);
    expect(reply).toContain(LINK);
  });

  /** A throw is what the router turns into the honesty template. A runtime that
   * returned an apology string instead would make a failed turn indistinguishable from
   * an answered one — in the thread, in the logs, and in the metrics. */
  it('throws when the loop produced no answer, and records the run as failed', async () => {
    const p = ports({ runAgent: answering(null, true) });

    await expect(channelCoachRuntime(p).respond(turn())).rejects.toThrow(/maxSteps/i);
    expect(p.recorded).toEqual([
      expect.objectContaining({ agentName: 'coach-channel-sms', status: 'failed' }),
    ]);
  });

  /**
   * VIL-260 · WS4 — a turn can commit drafts and THEN break: the two propose_* calls
   * land in the approvals queue, the model runs out of steps, and the router's honesty
   * template said "nothing was changed". It was a false statement about a real write,
   * and the orphaned drafts were left for an unrelated "yes" to approve.
   *
   * So a failed turn carries what it already did. The ids are minted by the tools, which
   * is why the sink is handed to `buildTools` rather than counted here.
   */
  it('surfaces the drafts a failed turn already committed', async () => {
    const sinks: Array<(actionId: string) => void> = [];
    const p = ports({
      buildTools: (_turn, onDraft) => {
        sinks.push(onDraft);
        return [] as RegisteredTool[];
      },
      runAgent: async () => {
        sinks[0]?.('action-1');
        sinks[0]?.('action-2');
        throw new Error('anthropic timeout');
      },
    });

    const err = await channelCoachRuntime(p)
      .respond(turn())
      .catch((e: unknown) => e);

    expect(draftsFromFailure(err)).toEqual(['action-1', 'action-2']);
    // The original failure is not swallowed by the enrichment.
    expect((err as Error).cause).toBeInstanceOf(Error);
  });

  it('surfaces nothing when a turn fails before it drafted anything', async () => {
    const p = ports({ runAgent: answering(null, true) });

    const err = await channelCoachRuntime(p)
      .respond(turn())
      .catch((e: unknown) => e);

    expect(draftsFromFailure(err)).toEqual([]);
    expect((err as Error).message).toMatch(/maxSteps/i);
  });

  it('records a completed run with its latency (the p50 the ticket gates on)', async () => {
    const p = ports();

    await channelCoachRuntime(p).respond(turn());

    expect(p.recorded).toEqual([
      expect.objectContaining({ agentName: 'coach-channel-sms', status: 'completed' }),
    ]);
    expect(p.recorded[0]?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  /** The per-turn draft cap lives in a closure inside the tool set, so a tool set
   * reused across texts would silently spend a later turn's budget on an earlier one. */
  it('builds a fresh tool set per turn', async () => {
    const buildTools = vi.fn(() => [] as RegisteredTool[]);
    const runtime = channelCoachRuntime(ports({ buildTools }));

    await runtime.respond(turn());
    await runtime.respond(turn());

    expect(buildTools).toHaveBeenCalledTimes(2);
  });
});

/**
 * The router builds its deps for EVERY inbound text, and most texts never reach a model:
 * an approval, a "done", a waitlist report are all answered by deterministic handlers
 * that run AFTER the deps are assembled. So constructing the coach must not require an
 * API key — otherwise one missing env var stops a parent approving a calendar write,
 * which is the failure a deployment is least likely to notice and most likely to cause.
 */
describe('productionChannelCoach', () => {
  it('constructs without ANTHROPIC_API_KEY, so a keyless deploy still takes approvals', async () => {
    const { productionChannelCoach } = await import('./runtime');
    const previous = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = undefined;
    // biome-ignore lint/performance/noDelete: the absent-key case is what is under test.
    delete process.env.ANTHROPIC_API_KEY;

    try {
      expect(() => productionChannelCoach({} as never)).not.toThrow();
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
    }
  });
});
