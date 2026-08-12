import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  type AgentClient,
  TOOL_RESULT_MAX_CHARS,
  type ToolResultEvent,
  runAgent,
  runAgentStreaming,
} from './agent.js';
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
  monetary: false,
  touchesChildContent: false,
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

  it('rides attachment blocks on the FIRST user turn alongside the serialized context', async () => {
    const client = fakeClient([textMessage('I see a mild rash.', usage(10, 5))]);
    const { deps } = guardDeps();
    const imageBlock: Anthropic.ImageBlockParam = {
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
    };

    await runAgent({
      skill,
      context: { question: 'what is this?' },
      tools: [profileTool],
      client,
      maxSteps: 2,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
      attachments: [imageBlock],
    });

    const createMock = client.messages.create as unknown as {
      mock: { calls: Array<[{ messages: Anthropic.MessageParam[] }]> };
    };
    const firstContent = createMock.mock.calls[0]?.[0].messages[0]?.content;
    // The first user turn becomes a block array: the context text, then the image block.
    expect(firstContent).toEqual([
      { type: 'text', text: JSON.stringify({ question: 'what is this?' }) },
      imageBlock,
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
      monetary: false,
      touchesChildContent: false,
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
      monetary: false,
      touchesChildContent: false,
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

  it('forwards ONLY a whitelisted card on onToolResult — a non-card field of the tool output never leaks (rule #1)', async () => {
    // The tool returns a whitelisted `card` AND a `secret` field. Only the card may
    // reach the client; the rest of the result goes to the model, never the stream.
    const cardTool = defineTool({
      name: 'drive_search',
      description: 'Search Drive.',
      monetary: false,
      touchesChildContent: false,
      inputSchema: z.object({ query: z.string() }),
      handler: async () => ({
        status: 'ok',
        secret: 'RAW-SERVER-ONLY-abc123',
        card: {
          kind: 'drive',
          files: [
            {
              name: 'Permission form',
              mimeType: 'application/pdf',
              modifiedTime: '2026-07-01T09:00:00Z',
              webViewLink: 'https://drive.google.com/file/d/f1/view',
            },
          ],
        },
      }),
    });
    const cardSkill: Skill = {
      meta: { name: 'ask-hale', whenToUse: 't', task: 'converse', tools: ['drive_search'] },
      instructions: 'You answer.',
    };
    const client = fakeStreamingClient([
      { chunks: [], final: toolUseMessage('tu-1', 'drive_search', { query: 'permission' }, usage(50, 10)) },
      { chunks: ['found ', 'it.'], final: textMessage('found it.', usage(60, 15)) },
    ]);
    const { deps } = guardDeps();
    const results: ToolResultEvent[] = [];

    await runAgentStreaming({
      skill: cardSkill,
      context: { question: 'is the form in my drive?' },
      tools: [cardTool],
      client,
      maxSteps: 5,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
      onTextDelta: () => {},
      onTurnReset: () => {},
      onToolResult: (e) => results.push(e),
    });

    expect(results).toHaveLength(1);
    const event = results[0];
    if (!event) throw new Error('expected one tool_result event');
    // The card came through with exactly the whitelisted fields.
    expect(event.card).toEqual({
      kind: 'drive',
      files: [
        {
          name: 'Permission form',
          mimeType: 'application/pdf',
          modifiedTime: '2026-07-01T09:00:00Z',
          webViewLink: 'https://drive.google.com/file/d/f1/view',
        },
      ],
    });
    // The non-card server-only field never rode the stream event.
    expect(JSON.stringify(event)).not.toContain('RAW-SERVER-ONLY-abc123');
    expect('secret' in event).toBe(false);
    expect('status' in event).toBe(false);
  });

  it('strips a deep extra field INSIDE a whitelisted card — a leak nested in card.files never reaches the client (rule #1)', async () => {
    // The card's KIND is whitelisted, but a file row carries an undeclared `secret`
    // (a raw file body would ride the exact same way). The firewall must parse the
    // card against the strict per-variant schema and drop that field at depth — a
    // check on `card.kind` alone would let it through.
    const smugglingTool = defineTool({
      name: 'drive_search',
      description: 'Search Drive.',
      monetary: false,
      touchesChildContent: false,
      inputSchema: z.object({ query: z.string() }),
      handler: async () => ({
        status: 'ok',
        card: {
          kind: 'drive',
          smuggledSibling: 'LEAK-ON-CARD-xyz',
          files: [
            {
              name: 'Permission form',
              mimeType: 'application/pdf',
              modifiedTime: '2026-07-01T09:00:00Z',
              webViewLink: 'https://drive.google.com/file/d/f1/view',
              secret: 'RAW-FILE-BODY-abc123',
            },
          ],
        },
      }),
    });
    const cardSkill: Skill = {
      meta: { name: 'ask-hale', whenToUse: 't', task: 'converse', tools: ['drive_search'] },
      instructions: 'You answer.',
    };
    const client = fakeStreamingClient([
      { chunks: [], final: toolUseMessage('tu-1', 'drive_search', { query: 'permission' }, usage(50, 10)) },
      { chunks: ['found ', 'it.'], final: textMessage('found it.', usage(60, 15)) },
    ]);
    const { deps } = guardDeps();
    const results: ToolResultEvent[] = [];

    await runAgentStreaming({
      skill: cardSkill,
      context: { question: 'is the form in my drive?' },
      tools: [smugglingTool],
      client,
      maxSteps: 5,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
      onTextDelta: () => {},
      onTurnReset: () => {},
      onToolResult: (e) => results.push(e),
    });

    expect(results).toHaveLength(1);
    const event = results[0];
    if (!event) throw new Error('expected one tool_result event');
    // The card carries ONLY the whitelisted fields — the deep `secret` and the
    // sibling `smuggledSibling` were both stripped by the schema.
    expect(event.card).toEqual({
      kind: 'drive',
      files: [
        {
          name: 'Permission form',
          mimeType: 'application/pdf',
          modifiedTime: '2026-07-01T09:00:00Z',
          webViewLink: 'https://drive.google.com/file/d/f1/view',
        },
      ],
    });
    // Neither smuggled value appears anywhere in the serialized event.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('RAW-FILE-BODY-abc123');
    expect(serialized).not.toContain('LEAK-ON-CARD-xyz');
  });

  it('does NOT attach a card when the tool output has none or an unknown card kind (rule #1)', async () => {
    // A tool whose `card.kind` is not one of the three whitelisted kinds must be
    // ignored — a tool can't smuggle arbitrary data to the client through `card`.
    const badCardTool = defineTool({
      name: 'get_child_profile',
      description: 'Read profile.',
      monetary: false,
      touchesChildContent: false,
      inputSchema: z.object({ childId: z.string() }),
      handler: async () => ({ card: { kind: 'evil', payload: 'leak-me' } }),
    });
    const client = fakeStreamingClient([
      { chunks: [], final: toolUseMessage('t', 'get_child_profile', { childId: 'k' }, usage(10, 5)) },
      { chunks: ['ok.'], final: textMessage('ok.', usage(10, 5)) },
    ]);
    const { deps } = guardDeps();
    const results: ToolResultEvent[] = [];

    await runAgentStreaming({
      skill,
      context: {},
      tools: [badCardTool],
      client,
      maxSteps: 5,
      toolContext: { familyId: 'fam-1', actor: 'agent-run-1' },
      guardDeps: deps,
      onTextDelta: () => {},
      onTurnReset: () => {},
      onToolResult: (e) => results.push(e),
    });

    expect(results).toHaveLength(1);
    const event = results[0];
    if (!event) throw new Error('expected one tool_result event');
    expect(event.card).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain('leak-me');
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

// ── the wire the model actually reads ────────────────────────────────────────
// Everything above exercises the loop's control flow. These assert the REQUEST:
// what the tool definitions look like by the time they leave the process, and
// how much of a tool's output is allowed back in.

/** Records every `messages.create` param object while replaying a script. */
function capturingClient(script: Anthropic.Message[]): {
  client: AgentClient;
  requests: Anthropic.MessageCreateParamsNonStreaming[];
} {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let calls = 0;
  const client = {
    messages: {
      create: vi.fn(async (params: Anthropic.MessageCreateParamsNonStreaming) => {
        requests.push(params);
        const msg = script[calls];
        calls += 1;
        if (!msg) throw new Error('capturingClient: script exhausted');
        return msg;
      }),
    },
  } as unknown as AgentClient;
  return { client, requests };
}

/** One named tool definition off the first request, as it left the process. */
function wireTool(
  requests: Anthropic.MessageCreateParamsNonStreaming[],
  name: string,
): Record<string, unknown> {
  const tools = (requests[0]?.tools ?? []) as unknown as Array<Record<string, unknown>>;
  const found = tools.find((t) => t.name === name);
  if (!found) throw new Error(`no '${name}' tool on the wire; got ${tools.length} tools`);
  return found;
}

describe('tool definitions on the wire', () => {
  const scheduleTool = defineTool({
    name: 'propose_calendar_move',
    description: 'Draft a re-time of one existing event.',
    monetary: false,
    touchesChildContent: false,
    inputSchema: z.object({
      eventId: z.string().min(1),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
      time: z.string(),
      note: z.string().optional(),
    }),
    inputExamples: [
      { eventId: 'evt-1', date: '2026-08-13', time: '17:15' },
      { eventId: 'evt-2', date: '2026-08-14', time: '09:00', note: 'after school' },
    ],
    handler: async () => ({ drafted: true }),
  });

  const scheduleSkill: Skill = {
    meta: {
      name: 'coach-channel-sms',
      whenToUse: 'test',
      task: 'converse',
      tools: ['propose_calendar_move'],
    },
    instructions: 'You are Hale over text.',
  };

  it('sends the tool’s REAL properties and required list, not a permissive placeholder', async () => {
    const { client, requests } = capturingClient([textMessage('ok.', usage(1, 1))]);
    const { deps } = guardDeps();

    await runAgent({
      skill: scheduleSkill,
      context: {},
      tools: [scheduleTool],
      client,
      maxSteps: 2,
      toolContext: { familyId: 'fam-1', actor: 'run-1' },
      guardDeps: deps,
    });

    const wire = wireTool(requests, 'propose_calendar_move');
    expect(wire.input_schema).toEqual({
      type: 'object',
      properties: {
        eventId: { type: 'string', description: 'At least 1 characters.' },
        date: { type: 'string', description: 'date must be YYYY-MM-DD' },
        time: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['eventId', 'date', 'time'],
      additionalProperties: false,
    });
  });

  it('sets strict:true per tool so the grammar constrains sampling', async () => {
    const { client, requests } = capturingClient([textMessage('ok.', usage(1, 1))]);
    const { deps } = guardDeps();

    await runAgent({
      skill: scheduleSkill,
      context: {},
      tools: [scheduleTool],
      client,
      maxSteps: 2,
      toolContext: { familyId: 'fam-1', actor: 'run-1' },
      guardDeps: deps,
    });

    expect(wireTool(requests, 'propose_calendar_move').strict).toBe(true);
  });

  it('WITHHOLDS strict for a tool whose schema has no grammar, and still sends the schema', async () => {
    // z.unknown() is "any JSON" — no grammar can be compiled, and sending
    // `strict` anyway is a 400. The properties must still reach the model.
    const saveMemory = defineTool({
      name: 'save_memory',
      description: 'Persist one durable fact.',
      monetary: false,
      touchesChildContent: false,
      inputSchema: z.object({ factKey: z.string(), factValue: z.unknown() }),
      handler: async () => ({ saved: true }),
    });
    const memorySkill: Skill = {
      meta: { name: 'ask-hale', whenToUse: 't', task: 'converse', tools: ['save_memory'] },
      instructions: 'x',
    };
    const { client, requests } = capturingClient([textMessage('ok.', usage(1, 1))]);
    const { deps } = guardDeps();

    await runAgent({
      skill: memorySkill,
      context: {},
      tools: [saveMemory],
      client,
      maxSteps: 2,
      toolContext: { familyId: 'fam-1', actor: 'run-1' },
      guardDeps: deps,
    });

    const wire = wireTool(requests, 'save_memory');
    expect(wire).not.toHaveProperty('strict');
    expect((wire.input_schema as Record<string, unknown>).required).toEqual(['factKey']);
  });

  it('forwards input_examples when the tool declares them, and omits the key when it does not', async () => {
    const { client, requests } = capturingClient([textMessage('ok.', usage(1, 1))]);
    const { deps } = guardDeps();

    await runAgent({
      skill: scheduleSkill,
      context: {},
      tools: [scheduleTool],
      client,
      maxSteps: 2,
      toolContext: { familyId: 'fam-1', actor: 'run-1' },
      guardDeps: deps,
    });
    expect(wireTool(requests, 'propose_calendar_move').input_examples).toEqual([
      { eventId: 'evt-1', date: '2026-08-13', time: '17:15' },
      { eventId: 'evt-2', date: '2026-08-14', time: '09:00', note: 'after school' },
    ]);

    // profileTool declares none — the key must be absent, not an empty array.
    const bare = capturingClient([textMessage('ok.', usage(1, 1))]);
    await runAgent({
      skill,
      context: {},
      tools: [profileTool],
      client: bare.client,
      maxSteps: 2,
      toolContext: { familyId: 'fam-1', actor: 'run-1' },
      guardDeps: guardDeps().deps,
    });
    expect(wireTool(bare.requests, 'get_child_profile')).not.toHaveProperty('input_examples');
  });
});

describe('tool results fed back to the model', () => {
  /** A tool whose output serializes to at least `chars` characters. */
  function bulkTool(chars: number) {
    return defineTool({
      name: 'get_child_profile',
      description: 'Read a child profile.',
      monetary: false,
      touchesChildContent: false,
      inputSchema: z.object({ childId: z.string() }),
      handler: async () => ({ blob: 'x'.repeat(chars) }),
    });
  }

  /** The tool_result content the loop appended after the first turn. */
  function toolResultContent(requests: Anthropic.MessageCreateParamsNonStreaming[]): string {
    const followUp = requests[1];
    if (!followUp) throw new Error('expected a second round-trip');
    const last = followUp.messages[followUp.messages.length - 1];
    const blocks = last?.content as Anthropic.ToolResultBlockParam[];
    return String(blocks[0]?.content);
  }

  async function runWith(tool: ReturnType<typeof bulkTool>): Promise<string> {
    const { client, requests } = capturingClient([
      toolUseMessage('tu-1', 'get_child_profile', { childId: 'kid-1' }, usage(1, 1)),
      textMessage('done.', usage(1, 1)),
    ]);
    await runAgent({
      skill,
      context: {},
      tools: [tool],
      client,
      maxSteps: 3,
      toolContext: { familyId: 'fam-1', actor: 'run-1' },
      guardDeps: guardDeps().deps,
    });
    return toolResultContent(requests);
  }

  it('passes a result under the ceiling through byte-for-byte', async () => {
    const content = await runWith(bulkTool(50));
    expect(content).toBe(JSON.stringify({ blob: 'x'.repeat(50) }));
  });

  it('caps an oversized result and NAMES the truncation in the payload (rule #11)', async () => {
    const content = await runWith(bulkTool(TOOL_RESULT_MAX_CHARS * 3));

    // Bounded — an unbounded result is a p95 latency and unpriced cost risk on
    // a turn a parent is watching three dots for.
    expect(content.length).toBeLessThan(TOOL_RESULT_MAX_CHARS + 500);
    // ...and the model is TOLD, rather than silently handed a cut-off object it
    // would otherwise read as the whole answer.
    expect(content).toContain('TRUNCATED');
    expect(content).toContain('get_child_profile');
    expect(content).toContain(String(TOOL_RESULT_MAX_CHARS));
    expect(content).toMatch(/do not (guess|invent)/i);
  });

  it('keeps the ceiling small enough to matter on a latency-bound turn', () => {
    // ~4 chars/token: the ceiling must stay well inside one SMS turn's budget,
    // or "bounded" is a nominal guarantee.
    expect(TOOL_RESULT_MAX_CHARS / 4).toBeLessThanOrEqual(4096);
  });
});

/**
 * The cached prefix (MEM-9 / G3).
 *
 * The wire order is tools → system → messages, so one ephemeral breakpoint on the
 * last system block covers the tool definitions AND the skill instructions — the
 * only two parts of the request that are identical for every run of a skill. The
 * per-run family context must sit AFTER that breakpoint (it rides the first user
 * message) or the "stable" prefix is a per-family string that never repeats and
 * the breakpoint only buys cache-write premiums.
 */
describe('prompt cache prefix', () => {
  const FAMILY_SECRET = 'Ella naps at 12:30';

  function systemsFrom(client: AgentClient): unknown[] {
    const mock = (client.messages as unknown as {
      create?: { mock: { calls: Array<[{ system: unknown }]> } };
      stream?: { mock: { calls: Array<[{ system: unknown }]> } };
    });
    const calls = (mock.create ?? mock.stream)?.mock.calls ?? [];
    return calls.map(([params]) => params.system);
  }

  it('marks the skill instructions as the ephemeral cache breakpoint', async () => {
    const client = fakeClient([textMessage('ok.', usage(10, 5))]);
    await runAgent({
      skill,
      context: { note: FAMILY_SECRET },
      tools: [profileTool],
      client,
      maxSteps: 2,
      toolContext: { familyId: 'fam-1', actor: 'run-1' },
      guardDeps: guardDeps().deps,
    });

    expect(systemsFrom(client)[0]).toEqual([
      {
        type: 'text',
        text: skill.instructions,
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('keeps per-family context OUT of the cached prefix and in the first user turn', async () => {
    const client = fakeClient([textMessage('ok.', usage(10, 5))]);
    await runAgent({
      skill,
      context: { note: FAMILY_SECRET },
      tools: [profileTool],
      client,
      maxSteps: 2,
      toolContext: { familyId: 'fam-1', actor: 'run-1' },
      guardDeps: guardDeps().deps,
    });

    // Cacheing a per-family system prompt would be a cache MISS every run — and
    // would put a child's routine in a prefix shared across the whole skill.
    expect(JSON.stringify(systemsFrom(client)[0])).not.toContain(FAMILY_SECRET);

    const createMock = client.messages.create as unknown as {
      mock: { calls: Array<[{ messages: Anthropic.MessageParam[] }]> };
    };
    expect(createMock.mock.calls[0]?.[0].messages[0]?.content).toBe(
      JSON.stringify({ note: FAMILY_SECRET }),
    );
  });

  it('sends a byte-identical prefix on every step of a multi-step loop', async () => {
    const client = fakeClient([
      toolUseMessage('tu-1', 'get_child_profile', { childId: 'kid-1' }, usage(10, 5)),
      textMessage('done.', usage(10, 5)),
    ]);
    await runAgent({
      skill,
      context: { note: FAMILY_SECRET },
      tools: [profileTool],
      client,
      maxSteps: 3,
      toolContext: { familyId: 'fam-1', actor: 'run-1' },
      guardDeps: guardDeps().deps,
    });

    const systems = systemsFrom(client);
    expect(systems).toHaveLength(2);
    // A prefix that differs by one byte between steps is re-processed at full
    // price on every round-trip — the exact cost this breakpoint exists to avoid.
    expect(JSON.stringify(systems[1])).toBe(JSON.stringify(systems[0]));
  });

  it('applies the same breakpoint on the streaming path', async () => {
    const client = fakeStreamingClient([
      { chunks: ['ok.'], final: textMessage('ok.', usage(10, 5)) },
    ]);
    await runAgentStreaming({
      skill,
      context: { note: FAMILY_SECRET },
      tools: [profileTool],
      client,
      maxSteps: 2,
      toolContext: { familyId: 'fam-1', actor: 'run-1' },
      guardDeps: guardDeps().deps,
      onTextDelta: () => {},
      onTurnReset: () => {},
    });

    expect(systemsFrom(client)[0]).toEqual([
      {
        type: 'text',
        text: skill.instructions,
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(JSON.stringify(systemsFrom(client)[0])).not.toContain(FAMILY_SECRET);
  });
});
