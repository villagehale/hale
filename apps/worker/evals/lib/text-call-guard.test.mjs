import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CACHE_DIR, cacheKey, cachedTextCall, makeCost } from './harness.mjs';

/**
 * A BLANK IS NOT A REPLY, and the cache is forever.
 *
 * `cachedToolCall` has refused to record a forced-tool call cut at `max_tokens` since
 * 2026-08-24, and the judge's draw has refused a score-less verdict since the verdict
 * guard beside this file. The free-text path — the compose arm of the radar, nudge and
 * model-matrix suites — had neither, and the committed cache carries ten `"text": ""`
 * entries to show for it: a fixture graded forever on a message the model never wrote,
 * with `--cached-only` replaying the blank at no cost and no warning.
 *
 * The line is drawn where production draws it. `runAgent` reports `truncated` exactly
 * when `stop_reason === 'max_tokens'` AND no text arrived (`packages/agent/src/agent.ts`),
 * because a stream that already put words on the wire cannot be re-asked. So a truncated
 * reply that DID speak is still recorded here — a cut-off sentence is something the length
 * gates and the judge can both see — and a reply that said nothing at all is refused.
 */
describe('the free-text call refuses to record a reply that is not there', () => {
  const model = 'claude-sonnet-4-6';
  const system = 'write the text';
  const userMessage = 'swim moved';

  function fakeClient(response) {
    return () => ({ messages: { create: async () => response } });
  }

  function keyFor(tag) {
    return cacheKey(tag, JSON.stringify({ model, system, userMessage }));
  }

  it('throws on a reply with no text and caches nothing', async () => {
    const tag = `text-guard-blank-${Math.random().toString(36).slice(2)}`;

    await expect(
      cachedTextCall({
        tag,
        model,
        system,
        userMessage,
        cachedOnly: false,
        getClient: fakeClient({
          stop_reason: 'max_tokens',
          content: [],
          usage: { input_tokens: 10, output_tokens: 1024 },
        }),
        cost: makeCost(),
      }),
    ).rejects.toThrow(/no text/i);

    expect(existsSync(join(CACHE_DIR, `${keyFor(tag)}.json`))).toBe(false);
  });

  it('throws on whitespace too - a reply of one newline is the same blank', async () => {
    const tag = `text-guard-space-${Math.random().toString(36).slice(2)}`;

    await expect(
      cachedTextCall({
        tag,
        model,
        system,
        userMessage,
        cachedOnly: false,
        getClient: fakeClient({
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: '\n ' }],
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        cost: makeCost(),
      }),
    ).rejects.toThrow(/no text/i);

    expect(existsSync(join(CACHE_DIR, `${keyFor(tag)}.json`))).toBe(false);
  });

  /**
   * THE POSITIVE CONTROL, and it is the truncated case on purpose: the guard must not
   * have become "refuse anything cut short", which would turn a reply the graders can
   * read into a dead run.
   */
  it('POSITIVE CONTROL - a truncated reply that still spoke is returned and recorded', async () => {
    const tag = `text-guard-spoke-${Math.random().toString(36).slice(2)}`;

    const result = await cachedTextCall({
      tag,
      model,
      system,
      userMessage,
      cachedOnly: false,
      getClient: fakeClient({
        stop_reason: 'max_tokens',
        content: [{ type: 'text', text: 'Swim moved to Tue 4:30. Want me to' }],
        usage: { input_tokens: 10, output_tokens: 1024 },
      }),
      cost: makeCost(),
    });

    expect(result.text).toBe('Swim moved to Tue 4:30. Want me to');

    const path = join(CACHE_DIR, `${keyFor(tag)}.json`);
    expect(existsSync(path)).toBe(true);
    // The committed cache is a corpus, not a scratch directory.
    rmSync(path, { force: true });
  });
});
