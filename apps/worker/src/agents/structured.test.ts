import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { cachedSystem, forceToolJson } from './structured.js';

/**
 * forceToolJson is the shared single-shot LLM helper behind coach, drafter,
 * classifier, and memory-inferencer (VIL-142). These tests mock the Anthropic
 * transport to assert the request SHAPE — specifically that the stable system
 * prefix carries a prompt-cache breakpoint and the variable per-run content
 * stays outside it — not the model's semantics (those are the cached-LLM eval,
 * hard rule #8).
 */

const TOOL = 'do_thing';

function toolUseMessage(): Anthropic.Message {
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
    content: [{ type: 'tool_use', id: 'tu_0', name: TOOL, input: { ok: true } }],
  };
}

function capturingClient(): {
  client: Pick<Anthropic, 'messages'>;
  create: ReturnType<typeof vi.fn>;
} {
  const create = vi.fn(async () => toolUseMessage());
  return { client: { messages: { create } } as unknown as Pick<Anthropic, 'messages'>, create };
}

describe('cachedSystem', () => {
  it('wraps instructions in one ephemeral-cached text block', () => {
    expect(cachedSystem('SYSTEM INSTRUCTIONS')).toEqual([
      { type: 'text', text: 'SYSTEM INSTRUCTIONS', cache_control: { type: 'ephemeral' } },
    ]);
  });
});

describe('forceToolJson — prompt caching', () => {
  const args = {
    model: 'claude-test',
    system: 'STABLE AGENT INSTRUCTIONS',
    userMessage: JSON.stringify({ question: 'VARIABLE PER-RUN PAYLOAD' }),
    toolName: TOOL,
    toolDescription: 'desc',
    inputJsonSchema: {
      type: 'object',
      properties: { ok: { type: 'boolean' } },
      required: ['ok'],
    } as Anthropic.Tool.InputSchema,
    schema: z.object({ ok: z.boolean() }),
  };

  it('marks the stable system prefix cacheable', async () => {
    const { client, create } = capturingClient();
    await forceToolJson({ client, ...args });

    const req = create.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(req.system).toEqual([
      {
        type: 'text',
        text: 'STABLE AGENT INSTRUCTIONS',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('keeps the variable per-run payload OUT of the cached prefix', async () => {
    const { client, create } = capturingClient();
    await forceToolJson({ client, ...args });

    const req = create.mock.calls[0]?.[0] as Anthropic.MessageCreateParamsNonStreaming;
    const systemText = JSON.stringify(req.system);
    expect(systemText).not.toContain('VARIABLE PER-RUN PAYLOAD');
    // The per-run content rides in messages, which render after system and so
    // sit outside the cached prefix.
    expect(req.messages).toEqual([{ role: 'user', content: args.userMessage }]);
  });
});
