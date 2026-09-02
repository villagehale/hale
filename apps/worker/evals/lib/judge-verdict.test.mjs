import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CACHE_DIR, cacheKey, isVerdict, makeCost, makeJudge } from './harness.mjs';

/**
 * A DRAW WITHOUT A SCORE IS NOT A VOTE.
 *
 * `cachedToolCall` has refused to cache a truncated forced-tool call since 2026-08-24 —
 * a response cut at `max_tokens` arrives as a well-formed object with `input: {}`, which
 * reads downstream as a model that looked and found nothing. The judge's own draw never
 * got that guard, and the judge's output IS the gate.
 *
 * What it cost: `activity-deep/cartwheels-live-research` had three committed draws of
 * `[{}, 2, 4]`. The empty one sorted by `a.score - b.score` compares NaN against
 * everything, so the median landed on the 2 and the suite failed on a message two of its
 * three real draws would have passed. The verdict printed as "judge:2 of /2/4" — the
 * blank is the draw that was never a draw. The judge schema puts `reason` before `score`
 * for a good reason (a score emitted first is a score reasoned backwards from), and the
 * price of that order is that `score` is exactly what truncation eats.
 */
describe('a judge verdict is a verdict only if it carries a number', () => {
  it.each([
    ['truncated to nothing', {}],
    ['reason written, score truncated off the end', { reason: 'a long argument' }],
    ['score present but not a number', { score: '4', reason: 'x' }],
    ['nothing at all', undefined],
  ])('refuses %s', (_label, parsed) => {
    expect(isVerdict(parsed)).toBe(false);
  });

  it('POSITIVE CONTROL - a whole verdict is one', () => {
    expect(isVerdict({ score: 2, reason: 'the watch sentence blames the page' })).toBe(true);
  });
});

/**
 * AND THE CALL SITE HAS TO READ IT. A predicate nothing consults is satisfied by a
 * predicate nobody wrote, so this drives the real `draw` with a real truncated response
 * and asserts the two things that must not happen: it must not be returned, and it must
 * not reach the cache to be replayed as a real draw forever.
 */
describe('the judge refuses to record a truncated draw', () => {
  const model = 'claude-sonnet-4-6';
  const system = 'score it';
  const payload = { message: 'a body under judgement' };

  function fakeClient(response) {
    return () => ({ messages: { create: async () => response } });
  }

  it('throws on a truncated tool call and caches nothing', async () => {
    const prefix = `judge-guard-truncated-${Math.random().toString(36).slice(2)}`;
    const judge = makeJudge(
      model,
      system,
      prefix,
      false,
      fakeClient({
        stop_reason: 'max_tokens',
        content: [{ type: 'tool_use', name: 'score', input: {} }],
        usage: { input_tokens: 10, output_tokens: 1024 },
      }),
      makeCost(),
      { samples: 3 },
    );

    await expect(judge('fixture', payload)).rejects.toThrow(/truncat/i);

    const key = cacheKey(`${prefix}:judge:fixture`, `${model}\n${system}\n${JSON.stringify(payload)}`);
    expect(existsSync(join(CACHE_DIR, `${key}.json`))).toBe(false);
  });

  it('POSITIVE CONTROL - a whole draw is returned and the median is real', async () => {
    const prefix = `judge-guard-whole-${Math.random().toString(36).slice(2)}`;
    const judge = makeJudge(
      model,
      system,
      prefix,
      false,
      fakeClient({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'score', input: { reason: 'sound', score: 4 } }],
        usage: { input_tokens: 10, output_tokens: 200 },
      }),
      makeCost(),
      { samples: 3 },
    );

    const verdict = await judge('fixture', payload);
    expect(verdict.score).toBe(4);
    expect(verdict.samples).toEqual([4, 4, 4]);

    // The committed cache is a corpus, not a scratch directory - a test that leaves three
    // fixtures' worth of "sound/4" in it has edited the corpus.
    for (const index of [0, 1, 2]) {
      const tag = index === 0 ? `${prefix}:judge:fixture` : `${prefix}:judge:fixture#${index}`;
      rmSync(join(CACHE_DIR, `${cacheKey(tag, `${model}\n${system}\n${JSON.stringify(payload)}`)}.json`), {
        force: true,
      });
    }
  });
});
