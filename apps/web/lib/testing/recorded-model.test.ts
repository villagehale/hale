import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { recordedModel } from './recorded-model';

/**
 * The journey cache is content-addressed on the prompt text. Wrapping that text
 * in a cache_control block must not miss a recording made against the string,
 * and two different prompts must not collapse to one key.
 */

const MODEL = 'claude-test';
const SYSTEM = 'STABLE AGENT INSTRUCTIONS';
const USER = 'VARIABLE PER-RUN PAYLOAD';

function keyFor(model: string, system: string, userMessage: string, thinking?: string): string {
  const mode = thinking ? `thinking:${thinking}\n` : '';
  return createHash('sha256').update(`${model}\n${mode}${system}\n${userMessage}`).digest('hex');
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

  it('does not answer the thinking-off re-ask with the turn it is re-asking', async () => {
    // forceToolJson re-asks a turn that spent its budget thinking, same model, system and
    // message with thinking off. Keyed without the thinking mode, the recorder handed the
    // re-ask the truncated recording it was retrying.
    const dir = mkdtempSync(join(tmpdir(), 'recorded-model-'));
    const path = join(dir, 'recordings.json');
    writeFileSync(path, recording(keyFor(MODEL, SYSTEM, USER, 'adaptive')));

    const recorded = recordedModel(path, () => ({}) as AgentClient);
    const ask = (thinking: string) =>
      recorded.client().messages.create({
        model: MODEL,
        max_tokens: 16,
        system: SYSTEM,
        messages: [{ role: 'user', content: USER }],
        thinking: { type: thinking },
      } as unknown as Anthropic.MessageCreateParams);

    await expect(ask('adaptive')).resolves.toMatchObject({ stop_reason: 'tool_use' });
    await expect(ask('between_tools')).rejects.toThrow(/no recording/);
  });
});

describe('recordedModel record mode', () => {
  it('refuses to record without HALE_MAX_USD and never builds the live client', async () => {
    vi.stubEnv('HALE_RECORD', '1');
    vi.stubEnv('HALE_MAX_USD', '');
    const dir = mkdtempSync(join(tmpdir(), 'recorded-model-'));
    const live = vi.fn(() => {
      throw new Error('live client must not be built uncapped');
    });
    const recorded = recordedModel(
      join(dir, 'recordings.json'),
      live as unknown as () => AgentClient,
    );
    try {
      await expect(
        recorded.client().messages.create({
          model: MODEL,
          max_tokens: 16,
          system: SYSTEM,
          messages: [{ role: 'user', content: USER }],
        }),
      ).rejects.toThrow(/needs BOTH HALE_MAX_USD and HALE_SPEND_LEDGER/);
      expect(live).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('refuses to record with a cap but no HALE_SPEND_LEDGER and never builds the live client', async () => {
    vi.stubEnv('HALE_RECORD', '1');
    vi.stubEnv('HALE_MAX_USD', '1');
    vi.stubEnv('HALE_SPEND_LEDGER', '');
    const dir = mkdtempSync(join(tmpdir(), 'recorded-model-'));
    const live = vi.fn(() => {
      throw new Error('live client must not be built uncapped');
    });
    const recorded = recordedModel(
      join(dir, 'recordings.json'),
      live as unknown as () => AgentClient,
    );
    try {
      await expect(
        recorded.client().messages.create({
          model: MODEL,
          max_tokens: 16,
          system: SYSTEM,
          messages: [{ role: 'user', content: USER }],
        }),
      ).rejects.toThrow(/needs BOTH HALE_MAX_USD and HALE_SPEND_LEDGER/);
      expect(live).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
