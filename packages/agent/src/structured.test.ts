import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentClient } from './agent.js';
import { HAIKU_MODEL, OPUS_MODEL, SONNET_MODEL, pickLane } from './model.js';
import {
  StructuredOutputError,
  cachedSystem,
  forceToolJson,
  strictToolSchema,
  structuredRequest,
} from './structured.js';

/**
 * forceToolJson MECHANICS against a fake transport: the request shape each 5.5 tier
 * accepts, and that every way a structured answer can fail to arrive is reported as
 * itself. Whether the model answers WELL is the cached live eval (rule #8).
 */

const TOOL = 'answer';
const SCHEMA = z.object({ found: z.boolean(), confidence: z.number() });
const JSON_SCHEMA = {
  type: 'object',
  properties: { found: { type: 'boolean' }, confidence: { type: 'number' } },
  required: ['found', 'confidence'],
} as const;

function message(
  content: unknown[],
  stopReason: string,
  extra: Record<string, unknown> = {},
): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-test',
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
    content,
    ...extra,
  } as unknown as Anthropic.Message;
}

/** The JSON-output answer: the grammar-constrained JSON in a text block. */
const ANSWER = message(
  [
    { type: 'thinking', thinking: '', signature: 'sig' },
    { type: 'text', text: '{"found":true,"confidence":0.9}' },
  ],
  'end_turn',
);
/** An open schema has no grammar, so it goes out as a tool. */
const OPEN_SCHEMA = {
  type: 'object',
  properties: { payload: { type: 'object', additionalProperties: true } },
  required: ['payload'],
} as const;
const OPEN_ANSWER = message(
  [{ type: 'tool_use', id: 'tu_0', name: TOOL, input: { payload: { a: 1 } } }],
  'tool_use',
);
const TEXT_ONLY = message([{ type: 'text', text: 'Here you go.' }], 'end_turn');

function fakeClient(...replies: Anthropic.Message[]) {
  const create = vi.fn(async (_params: Anthropic.MessageCreateParamsNonStreaming) => {
    const next = replies.shift();
    if (!next) throw new Error('fake client: no reply left');
    return next;
  });
  return { client: { messages: { create } } as unknown as AgentClient, create };
}

function call(client: AgentClient, task: Parameters<typeof pickLane>[0] = 'classify') {
  return forceToolJson({
    client,
    lane: pickLane(task),
    system: 'sys',
    userMessage: 'msg',
    toolName: TOOL,
    toolDescription: 'desc',
    inputJsonSchema: JSON_SCHEMA,
    schema: SCHEMA,
    maxTokens: 20,
  });
}

function callOpen(client: AgentClient, task: Parameters<typeof pickLane>[0] = 'draft') {
  return forceToolJson({
    client,
    lane: pickLane(task),
    system: 'sys',
    userMessage: 'msg',
    toolName: TOOL,
    toolDescription: 'desc',
    inputJsonSchema: OPEN_SCHEMA,
    schema: z.object({ payload: z.record(z.unknown()) }),
    maxTokens: 20,
  });
}

describe('structuredRequest — the shape each 5.5 tier accepts', () => {
  const base = {
    system: 'sys',
    userMessage: 'msg',
    toolName: TOOL,
    toolDescription: 'desc',
    inputJsonSchema: JSON_SCHEMA,
    maxTokens: 20,
  };

  it.each([
    ['screen', HAIKU_MODEL, { type: 'adaptive' }, 'medium'],
    ['classify', SONNET_MODEL, { type: 'adaptive' }, 'high'],
    ['high-stakes-judgment', OPUS_MODEL, { type: 'adaptive' }, 'xhigh'],
  ] as const)(
    'asks the %s lane (%s) for a JSON output, with no tool to escape into',
    (task, model, thinking, effort) => {
      const req = structuredRequest({ ...base, lane: pickLane(task) });
      expect(req).toMatchObject({ model, thinking });
      expect(req.output_config).toEqual({
        effort,
        format: { type: 'json_schema', schema: strictToolSchema(JSON_SCHEMA) },
      });
      expect(req).not.toHaveProperty('tools');
      expect(req).not.toHaveProperty('tool_choice');
    },
  );

  it('sends a schema the grammar cannot compile as a plain tool: forced on Haiku', () => {
    const req = structuredRequest({
      ...base,
      inputJsonSchema: OPEN_SCHEMA,
      lane: pickLane('screen'),
    });
    expect(req.tools).toEqual([{ name: TOOL, description: 'desc', input_schema: OPEN_SCHEMA }]);
    expect(req.tool_choice).toEqual({ type: 'tool', name: TOOL });
    expect(req.output_config).toEqual({ effort: 'medium' });
  });

  it('and auto with one call on the tiers that reject a forced tool_choice', () => {
    const req = structuredRequest({
      ...base,
      inputJsonSchema: OPEN_SCHEMA,
      lane: pickLane('draft'),
    });
    expect(req.tools?.[0]).not.toHaveProperty('strict');
    expect(req.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });
});

describe('strictToolSchema — the wire subset', () => {
  it('seals every object and restates stripped bounds in the description', () => {
    const projected = strictToolSchema({
      type: 'object',
      properties: {
        line: { type: 'string', maxLength: 160, description: 'The reply.' },
        score: { type: 'integer', minimum: 1, maximum: 5 },
        items: {
          type: 'array',
          maxItems: 3,
          items: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
        },
      },
      required: ['line', 'score', 'items'],
    });
    expect(projected).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: {
        line: { type: 'string', description: 'The reply. (maxLength: 160)' },
        score: { type: 'integer', description: '(minimum: 1, maximum: 5)' },
        items: {
          type: 'array',
          description: '(maxItems: 3)',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: { ref: { type: 'string' } },
            required: ['ref'],
          },
        },
      },
      required: ['line', 'score', 'items'],
    });
  });

  it('rewrites a nullable enum into the anyOf form the compiler accepts', () => {
    // `type: ['string','null']` beside an enum holding null is a 400 under strict
    // ("Enum value ... does not match declared type"), measured live 2026-10-11.
    expect(
      strictToolSchema({
        type: 'object',
        properties: { child: { type: ['string', 'null'], enum: ['Wren', null] } },
        required: ['child'],
      }),
    ).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { child: { anyOf: [{ type: 'string', enum: ['Wren'] }, { type: 'null' }] } },
      required: ['child'],
    });
  });

  it('keeps minItems 0 and 1, the only values the compiler supports', () => {
    const projected = strictToolSchema({
      type: 'object',
      properties: {
        one: { type: 'array', minItems: 1, items: { type: 'string' } },
        two: { type: 'array', minItems: 2, items: { type: 'string' } },
      },
      required: ['one', 'two'],
    });
    expect(projected?.properties).toEqual({
      one: { type: 'array', minItems: 1, items: { type: 'string' } },
      two: { type: 'array', description: '(minItems: 2)', items: { type: 'string' } },
    });
  });

  it('seals an object that is also allowed to be null', () => {
    expect(
      strictToolSchema({
        type: 'object',
        properties: {
          window: {
            type: ['object', 'null'],
            properties: { opens: { type: 'string' } },
            required: ['opens'],
          },
        },
        required: ['window'],
      })?.properties,
    ).toEqual({
      window: {
        type: ['object', 'null'],
        additionalProperties: false,
        properties: { opens: { type: 'string' } },
        required: ['opens'],
      },
    });
  });

  it('returns null for a node that accepts any value', () => {
    expect(
      strictToolSchema({
        type: 'object',
        properties: { anything: {}, label: { type: 'string', description: 'x' } },
        required: ['anything', 'label'],
      }),
    ).toBeNull();
  });

  it('returns null for keywords the compiler does not support', () => {
    expect(
      strictToolSchema({
        type: 'object',
        properties: { either: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
        required: ['either'],
      }),
    ).toBeNull();
  });

  it('returns null for an open object, which no grammar can express', () => {
    expect(
      strictToolSchema({
        type: 'object',
        properties: { blob: { type: 'object', additionalProperties: true } },
        required: ['blob'],
      }),
    ).toBeNull();
  });

  it('returns null for an object with no properties rather than sealing it shut', () => {
    expect(
      strictToolSchema({
        type: 'object',
        properties: { meta: { type: 'object' } },
        required: ['meta'],
      }),
    ).toBeNull();
  });

  it('returns null past the compiler limit on optional parameters', () => {
    const properties = Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`p${i}`, { type: 'string' }]),
    );
    expect(strictToolSchema({ type: 'object', properties, required: [] })).toBeNull();
    expect(
      strictToolSchema({ type: 'object', properties, required: Object.keys(properties).slice(1) }),
    ).not.toBeNull();
  });
});

describe('forceToolJson — every failure is reported as itself', () => {
  it('parses a complete answer (positive control)', async () => {
    const { client } = fakeClient(ANSWER);
    await expect(call(client)).resolves.toMatchObject({
      value: { found: true, confidence: 0.9 },
    });
  });

  it('names an answer that is not JSON instead of throwing a bare SyntaxError', async () => {
    const { client } = fakeClient(TEXT_ONLY);
    await expect(call(client)).rejects.toMatchObject({ outcome: 'unparseable', stage: TOOL });
  });

  it('re-asks once when a JSON output came back with no answer, and sums the usage', async () => {
    const { client, create } = fakeClient(message([], 'end_turn'), ANSWER);
    const result = await call(client);
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
    expect(result.value).toEqual({ found: true, confidence: 0.9 });
    expect(result.usage.input_tokens).toBe(20);
  });

  it('names a reply with no answer block at all once the re-ask is empty too', async () => {
    const { client, create } = fakeClient(message([], 'end_turn'), message([], 'end_turn'));
    await expect(call(client)).rejects.toMatchObject({ outcome: 'no_answer' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('parses an open-schema answer from its tool call (positive control)', async () => {
    const { client } = fakeClient(OPEN_ANSWER);
    await expect(callOpen(client)).resolves.toMatchObject({ value: { payload: { a: 1 } } });
  });

  it('re-asks once when an auto tool_choice answered in prose, and sums the usage', async () => {
    const { client, create } = fakeClient(TEXT_ONLY, OPEN_ANSWER);
    const result = await callOpen(client, 'draft');
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]?.[0]).toEqual(create.mock.calls[0]?.[0]);
    expect(result.value).toEqual({ payload: { a: 1 } });
    expect(result.usage.input_tokens).toBe(20);
    expect(result.usage.output_tokens).toBe(10);
  });

  it('names no_answer after the one re-ask also answers in prose', async () => {
    const { client, create } = fakeClient(TEXT_ONLY, TEXT_ONLY);
    const error = await callOpen(client, 'draft').catch((e: unknown) => e);
    expect(create).toHaveBeenCalledTimes(2);
    expect(error).toBeInstanceOf(StructuredOutputError);
    expect(error).toMatchObject({ outcome: 'no_answer', stage: TOOL });
  });

  it('does not re-ask a forced tool_choice that came back without the tool', async () => {
    const { client, create } = fakeClient(TEXT_ONLY);
    await expect(callOpen(client, 'screen')).rejects.toMatchObject({ outcome: 'no_answer' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('re-asks a turn that spent its whole budget thinking with thinking off, at the same budget', async () => {
    const thoughtOut = message(
      [{ type: 'thinking', thinking: '', signature: 'sig' }],
      'max_tokens',
    );
    const { client, create } = fakeClient(thoughtOut, ANSWER);
    const result = await call(client, 'classify');
    expect(create).toHaveBeenCalledTimes(2);
    const [first, second] = create.mock.calls.map(
      ([req]) => req as unknown as Record<string, unknown>,
    );
    expect(first?.thinking).toEqual({ type: 'adaptive' });
    expect(second?.thinking).toEqual({ type: 'between_tools' });
    expect(second?.max_tokens).toBe(first?.max_tokens);
    expect(second?.messages).toEqual(first?.messages);
    expect(result.value).toEqual({ found: true, confidence: 0.9 });
    expect(result.usage.output_tokens).toBe(10);
  });

  it('re-asks a turn that thought first and ran out mid-answer', async () => {
    const thoughtThenCut = message(
      [
        { type: 'thinking', thinking: '', signature: 'sig' },
        { type: 'text', text: '{"found":tr' },
      ],
      'max_tokens',
    );
    const { client, create } = fakeClient(thoughtThenCut, ANSWER);
    await expect(call(client, 'classify')).resolves.toMatchObject({
      value: { found: true, confidence: 0.9 },
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('does not re-ask a turn cut off while writing its answer', async () => {
    const cut = message([{ type: 'text', text: '{"found":tr' }], 'max_tokens');
    const { client, create } = fakeClient(cut);
    await expect(call(client, 'classify')).rejects.toMatchObject({ outcome: 'truncated' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('does not re-ask a lane that was not thinking', async () => {
    const thoughtOut = message(
      [{ type: 'thinking', thinking: '', signature: 'sig' }],
      'max_tokens',
    );
    const { client, create } = fakeClient(thoughtOut);
    await expect(call(client, 'speak')).rejects.toMatchObject({ outcome: 'truncated' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('names a refusal with its category and never re-asks it', async () => {
    const refusal = message([], 'refusal', { stop_details: { category: 'general_harms' } });
    const { client, create } = fakeClient(refusal);
    await expect(call(client, 'classify')).rejects.toMatchObject({
      outcome: 'refusal',
      category: 'general_harms',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('reports truncation as truncation, not as the missing-field ZodError it would parse to', async () => {
    const cut = message([{ type: 'text', text: '{"found":tr' }], 'max_tokens');
    const { client } = fakeClient(cut);
    const error = await call(client).catch((e: unknown) => e);
    expect(error).toMatchObject({ outcome: 'truncated' });
    expect(String(error)).toMatch(/truncated at max_tokens \(20\)/);
    expect(String(error)).not.toMatch(/Required/);
  });

  it('still lets the caller schema reject a value the wire schema could not bound', async () => {
    const bounded = z.object({ line: z.string().max(5) });
    const { client } = fakeClient(
      message([{ type: 'text', text: '{"line":"far too long"}' }], 'end_turn'),
    );
    await expect(
      forceToolJson({
        client,
        lane: pickLane('acknowledge'),
        system: 'sys',
        userMessage: 'msg',
        toolName: TOOL,
        toolDescription: 'desc',
        inputJsonSchema: {
          type: 'object',
          properties: { line: { type: 'string', maxLength: 5 } },
          required: ['line'],
        },
        schema: bounded,
        maxTokens: 20,
      }),
    ).rejects.toThrow(/at most 5/);
  });
});

describe('prompt caching', () => {
  it('wraps instructions in one ephemeral-cached text block', () => {
    expect(cachedSystem('SYSTEM INSTRUCTIONS')).toEqual([
      { type: 'text', text: 'SYSTEM INSTRUCTIONS', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('keeps the per-turn payload OUT of the cached prefix', async () => {
    const { client, create } = fakeClient(ANSWER);
    await forceToolJson({
      client,
      lane: pickLane('classify'),
      system: 'STABLE AGENT INSTRUCTIONS',
      userMessage: 'VARIABLE PER-RUN PAYLOAD',
      toolName: TOOL,
      toolDescription: 'desc',
      inputJsonSchema: JSON_SCHEMA,
      schema: SCHEMA,
      maxTokens: 20,
    });
    const req = create.mock.calls[0]?.[0];
    expect(req?.system).toEqual(cachedSystem('STABLE AGENT INSTRUCTIONS'));
    expect(JSON.stringify(req?.system)).not.toContain('VARIABLE PER-RUN PAYLOAD');
    expect(JSON.stringify((req as { output_config?: unknown })?.output_config)).not.toContain(
      'VARIABLE PER-RUN PAYLOAD',
    );
    expect(req?.messages).toEqual([{ role: 'user', content: 'VARIABLE PER-RUN PAYLOAD' }]);
  });

  it('sends the same request on the streamed transport', async () => {
    const stream = vi.fn((_params: Anthropic.MessageCreateParams) => ({
      finalMessage: async () => ANSWER,
    }));
    const result = await forceToolJson({
      client: { messages: { stream } } as unknown as AgentClient,
      lane: pickLane('classify'),
      system: 'sys',
      userMessage: 'msg',
      toolName: TOOL,
      toolDescription: 'desc',
      inputJsonSchema: JSON_SCHEMA,
      schema: SCHEMA,
      maxTokens: 20,
      transport: 'stream',
    });
    expect(result.value).toEqual({ found: true, confidence: 0.9 });
    expect(stream.mock.calls[0]?.[0]).toMatchObject({
      output_config: { format: { type: 'json_schema' } },
    });
  });
});
