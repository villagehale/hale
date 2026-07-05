import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type AgentClient, runAgent, runAgentStreaming } from './agent.js';
import type { Skill } from './skill.js';
import { type AuditEntry, type GuardDeps, defineTool } from './tool.js';

/**
 * A fake Anthropic client that replays a SCRIPT of messages. It exercises the
 * loop MECHANICS only (a tool call fed back, the maxSteps hard stop). Agent
 * QUALITY is evaluated against real cached Claude responses elsewhere (rule #8) —
 * this fake never stands in for the model's reasoning.
 */
function fakeClient(script: Anthropic.Message[]): AgentClient {
  let calls = 0;
  return {
    messages: {
      create: vi.fn(async () => {
        const msg = script[calls];
        calls += 1;
        if (!msg) {
          throw new Error('fakeClient: script exhausted');
        }
        return msg;
      }),
    },
  } as unknown as AgentClient;
}

function usage(input: number, output: number): Anthropic.Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
  };
}

function toolUseMessage(
  id: string,
  name: string,
  input: unknown,
  u: Anthropic.Usage,
): Anthropic.Message {
  return {
    id: 'msg-tool',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'tool_use',
    stop_sequence: null,
    content: [{ type: 'tool_use', id, name, input } as Anthropic.ToolUseBlock],
    usage: u,
  };
}

function textMessage(text: string, u: Anthropic.Usage): Anthropic.Message {
  return {
    id: 'msg-text',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [{ type: 'text', text, citations: null } as Anthropic.TextBlock],
    usage: u,
  };
}

const skill: Skill = {
  meta: {
    name: 'ask-hale',
    whenToUse: 'test',
    task: 'converse',
    tools: ['get_child_profile'],
  },
  instructions: 'You answer parenting questions.',
};

const profileTool = defineTool({
  name: 'get_child_profile',
  description: 'Read a child profile.',
  inputSchema: z.object({ childId: z.string() }),
  handler: async (input: { childId: string }) => ({ childId: input.childId, ageMonths: 5 }),
});

function guardDeps(): { deps: GuardDeps; audits: AuditEntry[] } {
  const audits: AuditEntry[] = [];
  return {
    audits,
    deps: {
      writeAudit: async (entry) => {
        audits.push(entry);
      },
    },
  };
}

describe('runAgent loop mechanics', () => {
  it('dispatches a tool call, feeds the result back, then returns the final answer', async () => {
    const client = fakeClient([
      toolUseMessage('tu-1', 'get_child_profile', { childId: 'kid-1' }, usage(100, 20)),
      textMessage('your 5-month-old is right on track.', usage(120, 30)),
    ]);
    const { deps, audits } = guardDeps();

    const result = await runAgent({
      skill,
      context: { question: 'is my baby on track?' },
      tools: [profileTool],
      client,
      maxSteps: 5,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
    });

    expect(result.answer).toBe('your 5-month-old is right on track.');
    expect(result.steps).toBe(2);
    expect(result.hitMaxSteps).toBe(false);
    // Usage is summed across both round-trips.
    expect(result.usage).toEqual({ promptTokens: 220, completionTokens: 50 });
    // The tool went through the guarded invoker → an audit row was written (rule #6).
    expect(audits).toEqual([
      {
        familyId: 'fam-1',
        actor: 'agent-run-1',
        actionTaken: 'tool:get_child_profile',
        after: { childId: 'kid-1' },
      },
    ]);
  });

  it('hard-stops at maxSteps when the model keeps calling tools', async () => {
    const client = fakeClient([
      toolUseMessage('a', 'get_child_profile', { childId: 'k' }, usage(10, 5)),
      toolUseMessage('b', 'get_child_profile', { childId: 'k' }, usage(10, 5)),
      toolUseMessage('c', 'get_child_profile', { childId: 'k' }, usage(10, 5)),
      textMessage('done', usage(10, 5)),
    ]);
    const { deps } = guardDeps();

    const result = await runAgent({
      skill,
      context: {},
      tools: [profileTool],
      client,
      maxSteps: 2,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
    });

    expect(result.hitMaxSteps).toBe(true);
    expect(result.answer).toBeNull();
    expect(result.steps).toBe(2);
  });

  it('feeds a bad-argument tool error back to the model instead of crashing the turn', async () => {
    // Regression: the model invented an out-of-schema arg (childId must be a string).
    // invokeTool's parse throws — the loop must return an is_error tool_result so the
    // model self-corrects, NOT propagate the throw and 500 the whole request.
    const client = fakeClient([
      toolUseMessage('tu-bad', 'get_child_profile', { childId: 42 }, usage(50, 10)),
      textMessage('here is general guidance.', usage(60, 15)),
    ]);
    const { deps, audits } = guardDeps();

    const result = await runAgent({
      skill,
      context: { question: 'help' },
      tools: [profileTool],
      client,
      maxSteps: 5,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
    });

    // The turn did NOT crash — the model got the error back and answered.
    expect(result.answer).toBe('here is general guidance.');
    expect(result.steps).toBe(2);
    expect(result.hitMaxSteps).toBe(false);
    // The rejected call's handler never ran, so nothing was audited (rule #6).
    expect(audits).toEqual([]);
  });

  it('refuses a tool the skill does not list, even if the model calls it', async () => {
    const client = fakeClient([
      toolUseMessage('x', 'place_supply_order', { item: 'wipes' }, usage(10, 5)),
    ]);
    const { deps } = guardDeps();
    const orderTool = defineTool({
      name: 'place_supply_order',
      description: 'Order supplies.',
      inputSchema: z.object({ item: z.string() }),
      handler: async () => ({ ok: true }),
    });

    await expect(
      runAgent({
        skill,
        context: {},
        tools: [profileTool, orderTool],
        client,
        maxSteps: 3,
        toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
        guardDeps: deps,
      }),
    ).rejects.toThrow(/not in skill 'ask-hale' allowlist/);
  });
});

/**
 * A fake MessageStream: yields one text_delta event per supplied chunk (the SDK's
 * `content_block_delta`), then resolves `finalMessage()` with the assembled
 * Message. Tool turns carry no text chunks — only the tool_use in finalMessage.
 * Plumbing only (rule #8); the model's reasoning is never simulated here.
 */
function fakeStream(chunks: string[], final: Anthropic.Message) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const text of chunks) {
        yield {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        } as Anthropic.MessageStreamEvent;
      }
    },
    finalMessage: async () => final,
  };
}

function fakeStreamingClient(
  script: Array<{ chunks: string[]; final: Anthropic.Message }>,
): AgentClient {
  let calls = 0;
  return {
    messages: {
      stream: vi.fn(() => {
        const turn = script[calls];
        calls += 1;
        if (!turn) {
          throw new Error('fakeStreamingClient: script exhausted');
        }
        return fakeStream(turn.chunks, turn.final);
      }),
    },
  } as unknown as AgentClient;
}

describe('runAgentStreaming', () => {
  it('streams the final answer token-by-token and returns the joined text', async () => {
    const client = fakeStreamingClient([
      {
        chunks: ['around ', 'six ', 'months.'],
        final: textMessage('around six months.', usage(80, 12)),
      },
    ]);
    const { deps } = guardDeps();
    const deltas: string[] = [];
    let resets = 0;

    const result = await runAgentStreaming({
      skill,
      context: { question: 'when do I start solids?' },
      tools: [profileTool],
      client,
      maxSteps: 5,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
      onTextDelta: (d) => deltas.push(d),
      onTurnReset: () => {
        resets += 1;
      },
    });

    // Every token was forwarded, in order, and the joined deltas equal the answer.
    expect(deltas).toEqual(['around ', 'six ', 'months.']);
    expect(deltas.join('')).toBe(result.answer);
    expect(result.answer).toBe('around six months.');
    expect(result.steps).toBe(1);
    expect(result.hitMaxSteps).toBe(false);
    expect(result.usage).toEqual({ promptTokens: 80, completionTokens: 12 });
    // The single answer turn never reset.
    expect(resets).toBe(0);
  });

  it('runs the guarded tool turn, fires onTurnReset, then streams only the answer', async () => {
    const client = fakeStreamingClient([
      {
        chunks: [],
        final: toolUseMessage('tu-1', 'get_child_profile', { childId: 'kid-1' }, usage(100, 20)),
      },
      {
        chunks: ['right ', 'on ', 'track.'],
        final: textMessage('right on track.', usage(120, 30)),
      },
    ]);
    const { deps, audits } = guardDeps();
    const deltas: string[] = [];
    let resets = 0;

    const result = await runAgentStreaming({
      skill,
      context: { question: 'is my baby on track?' },
      tools: [profileTool],
      client,
      maxSteps: 5,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
      onTextDelta: (d) => deltas.push(d),
      onTurnReset: () => {
        resets += 1;
      },
    });

    // The tool turn produced no answer text; the reset fired once for it.
    expect(resets).toBe(1);
    // Only the final turn's tokens reached the client.
    expect(deltas).toEqual(['right ', 'on ', 'track.']);
    expect(result.answer).toBe('right on track.');
    expect(result.steps).toBe(2);
    // Usage summed across both round-trips.
    expect(result.usage).toEqual({ promptTokens: 220, completionTokens: 50 });
    // The tool went through the guarded invoker → an audit row (rule #6).
    expect(audits).toEqual([
      {
        familyId: 'fam-1',
        actor: 'agent-run-1',
        actionTaken: 'tool:get_child_profile',
        after: { childId: 'kid-1' },
      },
    ]);
  });

  it('fires onStep/onToolCall/onToolResult in order, name+ok+preview only, NEVER raw args or output (rule #1)', async () => {
    // The tool_use carries a real childId in its args, and the tool HANDLER returns a
    // child's name — both are teen-sensitive. The step/tool events must expose the
    // tool NAME, the outcome, and a content-free preview, and NOTHING drawn from the
    // args or the handler's output (rule #1).
    const SENSITIVE_CHILD_ID = 'kid-secret-42';
    const nameLeakingTool = defineTool({
      name: 'get_child_profile',
      description: 'Read a child profile.',
      inputSchema: z.object({ childId: z.string() }),
      handler: async (input: { childId: string }) => ({
        childId: input.childId,
        // A teen's real name in the tool OUTPUT — must never reach a stream event.
        name: 'Priya',
      }),
    });
    const client = fakeStreamingClient([
      {
        chunks: ['thinking'],
        final: toolUseMessage(
          'tu-1',
          'get_child_profile',
          { childId: SENSITIVE_CHILD_ID },
          usage(100, 20),
        ),
      },
      {
        chunks: ['all ', 'good.'],
        final: textMessage('all good.', usage(120, 30)),
      },
    ]);
    const { deps } = guardDeps();
    // One ordered log across every hook, so we assert the emission SEQUENCE.
    const events: Array<Record<string, unknown>> = [];

    const result = await runAgentStreaming({
      skill,
      context: { question: 'is my teen ok?' },
      tools: [nameLeakingTool],
      client,
      maxSteps: 5,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
      onTextDelta: () => {},
      onTurnReset: () => {},
      onStep: (step) => events.push({ hook: 'step', step }),
      onToolCall: (e) => events.push({ hook: 'tool_call', ...e }),
      onToolResult: (e) => events.push({ hook: 'tool_result', ...e }),
    });

    // Order: step 1 → the tool call → its result → step 2 (the answer turn).
    expect(events).toEqual([
      { hook: 'step', step: 1 },
      { hook: 'tool_call', name: 'get_child_profile' },
      { hook: 'tool_result', name: 'get_child_profile', ok: true, preview: 'Ran get_child_profile' },
      { hook: 'step', step: 2 },
    ]);

    // Rule #1, structural: the tool_call carries the NAME and only the name — no
    // `input`/`childId`/args field, and nothing equal to the sensitive id.
    const call = events.find((e) => e.hook === 'tool_call');
    expect(Object.keys(call ?? {}).sort()).toEqual(['hook', 'name']);

    // Rule #1: the sensitive childId (from args) and the child's name (from the tool
    // output) appear NOWHERE in the serialized event stream.
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(SENSITIVE_CHILD_ID);
    expect(serialized).not.toContain('Priya');

    // The answer path is unaffected.
    expect(result.answer).toBe('all good.');
    expect(result.steps).toBe(2);
  });

  it('reports ok:false with a content-free preview when a tool call is refused (rule #1)', async () => {
    // A bad argument (childId must be a string) makes invokeTool throw at the parse
    // boundary — the loop feeds the error back to the model AND fires onToolResult
    // with ok:false, so a refusal is observable, never silent.
    const client = fakeStreamingClient([
      {
        chunks: [],
        final: toolUseMessage('tu-bad', 'get_child_profile', { childId: 42 }, usage(50, 10)),
      },
      { chunks: ['here ', 'is guidance.'], final: textMessage('here is guidance.', usage(60, 15)) },
    ]);
    const { deps } = guardDeps();
    const results: Array<{ name: string; ok: boolean; preview: string }> = [];

    const result = await runAgentStreaming({
      skill,
      context: { question: 'help' },
      tools: [profileTool],
      client,
      maxSteps: 5,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
      onTextDelta: () => {},
      onTurnReset: () => {},
      onToolResult: (e) => results.push(e),
    });

    expect(results).toEqual([
      { name: 'get_child_profile', ok: false, preview: 'get_child_profile was blocked' },
    ]);
    // The turn did not crash — the model got the error back and answered.
    expect(result.answer).toBe('here is guidance.');
  });
});
