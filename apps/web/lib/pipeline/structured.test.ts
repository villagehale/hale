import type { AgentClient } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { forceToolJson } from './structured';

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
    model: 'claude-sonnet-5',
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
});
