import type Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, SONNET55_MODEL, pickLane } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { cachedSystem, forceToolJson } from './structured';

/**
 * forceToolJson mechanics — specifically that a max_tokens-truncated forced tool
 * call is reported AS truncation, not as a schema failure.
 *
 * The trap this defends (registration re-verify Shape A): a response cut off at
 * max_tokens returns `tool_use.input = {}`, and parsing {} against a schema with
 * required fields yields an "every field is Required" ZodError that reads exactly
 * like a genuine bad-shape answer — masking the real cause. The guard turns that
 * into a distinct, truthful signal so a truncated read is never mislabelled.
 */

function clientReturning(payload: { content: unknown[]; stop_reason: string }): AgentClient {
  return {
    messages: {
      create: async () => ({ ...payload, usage: { input_tokens: 10, output_tokens: 10 } }),
    },
  } as unknown as AgentClient;
}

const SCHEMA = z.object({ found: z.boolean(), confidence: z.number() });
const JSON_SCHEMA = {
  type: 'object',
  properties: { found: { type: 'boolean' }, confidence: { type: 'number' } },
  required: ['found', 'confidence'],
} as const;

function call(client: AgentClient) {
  return forceToolJson({
    client,
    lane: pickLane('classify'),
    system: 'sys',
    userMessage: 'msg',
    toolName: 'answer',
    toolDescription: 'desc',
    inputJsonSchema: JSON_SCHEMA,
    schema: SCHEMA,
    maxTokens: 20,
  });
}

describe('forceToolJson — truncation is not a schema failure', () => {
  it('throws a truncation error when the tool call is cut off at max_tokens', async () => {
    const client = clientReturning({
      content: [{ type: 'tool_use', name: 'answer', input: {} }],
      stop_reason: 'max_tokens',
    });
    await expect(call(client)).rejects.toThrow(/truncated at max_tokens/);
  });

  it('does NOT report the empty input as a missing-field schema error', async () => {
    // Without the guard this rejects with a ZodError naming every required field
    // "Required", hiding that the answer was simply cut off.
    const client = clientReturning({
      content: [{ type: 'tool_use', name: 'answer', input: {} }],
      stop_reason: 'max_tokens',
    });
    await expect(call(client)).rejects.not.toThrow(/Required/);
  });

  it('parses a complete answer through the same path (positive control)', async () => {
    const client = clientReturning({
      content: [{ type: 'tool_use', name: 'answer', input: { found: true, confidence: 0.9 } }],
      stop_reason: 'tool_use',
    });
    const { value } = await call(client);
    expect(value).toEqual({ found: true, confidence: 0.9 });
  });

  it('uses the tool-choice shape supported by Sonnet 5.5', async () => {
    const create = vi.fn(async () => ({
      content: [
        {
          type: 'tool_use',
          name: 'answer',
          input: { found: true, confidence: 0.9 },
        },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 10, output_tokens: 10 },
    }));

    await forceToolJson({
      client: { messages: { create } } as unknown as AgentClient,
      lane: { model: SONNET55_MODEL, thinking: 'adaptive', effort: 'high' },
      system: 'sys',
      userMessage: 'msg',
      toolName: 'answer',
      toolDescription: 'desc',
      inputJsonSchema: JSON_SCHEMA,
      schema: SCHEMA,
      maxTokens: 20,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        model: SONNET55_MODEL,
        tool_choice: { type: 'auto' },
      }),
    );
  });
});

/**
 * Prompt caching (VIL-142). These tests mock the transport to assert the request
 * SHAPE — the stable system prefix carries an ephemeral breakpoint and the
 * per-turn payload stays outside it — not the model's words (those are the
 * cached-LLM eval, hard rule #8).
 */

const CACHE_TOOL = 'do_thing';

function cacheToolUseMessage(): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
    },
    content: [{ type: 'tool_use', id: 'tu_0', name: CACHE_TOOL, input: { ok: true } }],
  };
}

const cacheArgs = {
  lane: pickLane('classify'),
  system: 'STABLE AGENT INSTRUCTIONS',
  userMessage: JSON.stringify({
    childName: 'VARIABLE PER-RUN PAYLOAD',
    now: '2026-10-05T12:00:00Z',
  }),
  toolName: CACHE_TOOL,
  toolDescription: 'desc',
  inputJsonSchema: {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  } as Anthropic.Tool.InputSchema,
  schema: z.object({ ok: z.boolean() }),
  maxTokens: 64,
};

describe('cachedSystem', () => {
  it('wraps instructions in one ephemeral-cached text block', () => {
    expect(cachedSystem('SYSTEM INSTRUCTIONS')).toEqual([
      { type: 'text', text: 'SYSTEM INSTRUCTIONS', cache_control: { type: 'ephemeral' } },
    ]);
  });
});

describe('forceToolJson — prompt caching', () => {
  it('marks the stable system prefix cacheable', async () => {
    const create = vi.fn(async (_params: Anthropic.MessageCreateParamsNonStreaming) =>
      cacheToolUseMessage(),
    );
    await forceToolJson({
      client: { messages: { create } } as unknown as AgentClient,
      ...cacheArgs,
    });

    const req = create.mock.calls[0]?.[0];
    if (!req) throw new Error('forceToolJson did not call the model');
    expect(req.system).toEqual([
      {
        type: 'text',
        text: 'STABLE AGENT INSTRUCTIONS',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('keeps per-turn names and timestamps OUT of the cached prefix', async () => {
    const create = vi.fn(async (_params: Anthropic.MessageCreateParamsNonStreaming) =>
      cacheToolUseMessage(),
    );
    await forceToolJson({
      client: { messages: { create } } as unknown as AgentClient,
      ...cacheArgs,
    });

    const req = create.mock.calls[0]?.[0];
    if (!req) throw new Error('forceToolJson did not call the model');
    const cached = JSON.stringify(req.system);
    expect(cached).not.toContain('VARIABLE PER-RUN PAYLOAD');
    expect(cached).not.toContain('2026-10-05T12:00:00Z');
    // Tools sit before system on the wire, so the system breakpoint covers them.
    // They are the stable schema, not this turn's family state.
    expect(JSON.stringify(req.tools)).not.toContain('VARIABLE PER-RUN PAYLOAD');
    expect(req.tools?.[0]).not.toHaveProperty('cache_control');
    expect(req.messages).toEqual([{ role: 'user', content: cacheArgs.userMessage }]);
    expect(JSON.stringify(req.messages)).not.toContain('cache_control');
  });

  it('marks the same prefix on the streamed transport', async () => {
    const stream = vi.fn((_params: Anthropic.MessageCreateParams) => ({
      finalMessage: async () => cacheToolUseMessage(),
    }));
    await forceToolJson({
      client: { messages: { stream } } as unknown as AgentClient,
      ...cacheArgs,
      transport: 'stream',
    });

    const req = stream.mock.calls[0]?.[0];
    if (!req) throw new Error('forceToolJson did not call the model');
    expect(req.system).toEqual([
      {
        type: 'text',
        text: 'STABLE AGENT INSTRUCTIONS',
        cache_control: { type: 'ephemeral' },
      },
    ]);
    expect(JSON.stringify(req.system)).not.toContain('VARIABLE PER-RUN PAYLOAD');
  });
});
