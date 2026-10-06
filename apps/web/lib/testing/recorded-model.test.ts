import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { recordedModel } from './recorded-model';

/**
 * The journey cache is content-addressed on the prompt text. Wrapping that text
 * in a cache_control block must not miss a recording made against the string,
 * and two different prompts must not collapse to one key.
 */

const MODEL = 'claude-test';
const SYSTEM = 'STABLE AGENT INSTRUCTIONS';
const USER = 'VARIABLE PER-RUN PAYLOAD';

function keyFor(model: string, system: string, userMessage: string): string {
  return createHash('sha256').update(`${model}\n${system}\n${userMessage}`).digest('hex');
}

function recording(key: string): string {
  return JSON.stringify(
    {
      [key]: {
        key,
        recordedAt: '2026-10-05T00:00:00.000Z',
        request: { model: MODEL, userMessage: USER },
        response: {
          content: [{ type: 'tool_use', id: 'tu_0', name: 'reply', input: { ok: true } }],
          stop_reason: 'tool_use',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      },
    },
    null,
    2,
  );
}

describe('recordedModel cache key', () => {
  it('replays a string-keyed recording when system is a cached text block', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recorded-model-'));
    const path = join(dir, 'recordings.json');
    writeFileSync(path, recording(keyFor(MODEL, SYSTEM, USER)));

    const recorded = recordedModel(path, () => {
      throw new Error('live client must not be called on a hit');
    });
    const response = await recorded.client().messages.create({
      model: MODEL,
      max_tokens: 16,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: USER }],
    });

    expect(response.content).toEqual([
      { type: 'tool_use', id: 'tu_0', name: 'reply', input: { ok: true } },
    ]);
  });

  it('does not replay a different system prompt under the same wrapper', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recorded-model-'));
    const path = join(dir, 'recordings.json');
    writeFileSync(path, recording(keyFor(MODEL, SYSTEM, USER)));

    const recorded = recordedModel(path, () => ({}) as AgentClient);
    const params: Anthropic.MessageCreateParams = {
      model: MODEL,
      max_tokens: 16,
      system: [{ type: 'text', text: 'A DIFFERENT PROMPT', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: USER }],
    };

    await expect(recorded.client().messages.create(params)).rejects.toThrow(/no recording/);
  });
});
