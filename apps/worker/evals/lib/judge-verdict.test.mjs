import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CACHE_DIR,
  cacheKey,
  isVerdict,
  makeCost,
  makeJudge,
  scoreFirstJudgeSchema,
} from './harness.mjs';

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
  const model = 'claude-opus-5-5';
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
        content: [{ type: 'text', text: '{"reason":"the reply is' }],
        usage: { input_tokens: 10, output_tokens: 1024 },
      }),
      makeCost(),
      { samples: 3 },
    );

    await expect(judge('fixture', payload)).rejects.toThrow(/truncat/i);

    const key = cacheKey(
      `${prefix}:judge:fixture`,
      `${model}\n${system}\n${JSON.stringify(payload)}`,
    );
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
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: '{"reason":"sound","score":4}' }],
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
      rmSync(
        join(CACHE_DIR, `${cacheKey(tag, `${model}\n${system}\n${JSON.stringify(payload)}`)}.json`),
        {
          force: true,
        },
      );
    }
  });

  it('still throws when a shared-schema draw is cut off even if a score is already present', async () => {
    const prefix = `judge-guard-score-cut-${Math.random().toString(36).slice(2)}`;
    const judge = makeJudge(
      model,
      system,
      prefix,
      false,
      fakeClient({
        stop_reason: 'max_tokens',
        content: [{ type: 'tool_use', name: 'score', input: { score: 5, reason: 'cut' } }],
        usage: { input_tokens: 10, output_tokens: 440 },
      }),
      makeCost(),
    );

    await expect(judge('fixture', payload)).rejects.toThrow(/truncat/i);
    const key = cacheKey(
      `${prefix}:judge:fixture`,
      `${model}\n${system}\n${JSON.stringify(payload)}`,
    );
    expect(existsSync(join(CACHE_DIR, `${key}.json`))).toBe(false);
  });

  it('keeps a score-first draw whose reason was cut off', async () => {
    const prefix = `judge-guard-score-kept-${Math.random().toString(36).slice(2)}`;
    const judge = makeJudge(
      model,
      system,
      prefix,
      false,
      fakeClient({
        stop_reason: 'max_tokens',
        content: [{ type: 'tool_use', name: 'score', input: { score: 5, reason: 'cut' } }],
        usage: { input_tokens: 10, output_tokens: 440 },
      }),
      makeCost(),
      { toolSchema: scoreFirstJudgeSchema(160), keepTruncatedScore: true },
    );

    await expect(judge('fixture', payload)).resolves.toMatchObject({ score: 5, reason: 'cut' });
    const key = cacheKey(
      `${prefix}:judge:fixture`,
      `${model}\n${system}\n${JSON.stringify(payload)}`,
    );
    rmSync(join(CACHE_DIR, `${key}.json`), { force: true });
  });

  it('does not count a truncated draw again when the cap gate already booked it', async () => {
    const prefix = `judge-guard-cap-booked-${Math.random().toString(36).slice(2)}`;
    const cost = makeCost();
    const judge = makeJudge(
      model,
      system,
      prefix,
      false,
      fakeClient({
        stop_reason: 'max_tokens',
        capBooked: true,
        content: [{ type: 'tool_use', name: 'score', input: { score: 5, reason: 'cut' } }],
        usage: { input_tokens: 10, output_tokens: 440 },
      }),
      cost,
      { toolSchema: scoreFirstJudgeSchema(160), keepTruncatedScore: true },
    );

    await expect(judge('fixture', payload)).resolves.toMatchObject({ score: 5 });
    expect(cost.liveCalls).toBe(0);
    const key = cacheKey(
      `${prefix}:judge:fixture`,
      `${model}\n${system}\n${JSON.stringify(payload)}`,
    );
    rmSync(join(CACHE_DIR, `${key}.json`), { force: true });
  });
});

describe('score-first judge schema', () => {
  it('puts score before reason and caps the reason', () => {
    const schema = scoreFirstJudgeSchema(160);
    expect(Object.keys(schema.properties)).toEqual(['score', 'reason']);
    expect(schema.required).toEqual(['score', 'reason']);
    expect(schema.properties.reason.maxLength).toBe(160);
  });
});

/**
 * A VERDICT CUT OFF AT THE JUDGE'S OUTPUT CAP IS A JUDGE ERROR (914). The cap exists so
 * the spend guard reserves a small worst case; it must never turn into a pass, a cached
 * draw, or a quiet second ask.
 */
describe('a capped judge stops the run on a verdict that hits the cap', () => {
  it.each(['claude-sonnet-5-5', 'claude-haiku-5-5'])(
    '%s: throws JudgeTruncatedError, one call, nothing cached',
    async (model) => {
      const { JudgeTruncatedError } = await import('./harness.mjs');
      const prefix = `judge-cap-${Math.random().toString(36).slice(2)}`;
      const requests = [];
      const create = async (request) => {
        requests.push(request);
        return {
          stop_reason: 'max_tokens',
          content: [{ type: 'text', text: '{"reason":"the reply is' }],
          usage: { input_tokens: 10, output_tokens: 512 },
        };
      };
      const judge = makeJudge(
        model,
        'score it',
        prefix,
        false,
        () => ({ messages: { create } }),
        makeCost(),
        {
          samples: 3,
          aggregate: 'min',
          maxOutputTokens: 512,
        },
      );
      const err = await judge('fixture', { text: 'x' }).catch((e) => e);
      expect(err).toBeInstanceOf(JudgeTruncatedError);
      expect(err.message).toMatch(/max_tokens cap \(512\)/);
      expect(requests).toHaveLength(1);
      expect(requests[0].max_tokens).toBe(512);
      // the cap bounds the verdict only: the capped lane never thinks
      expect(requests[0].thinking.type).not.toBe('adaptive');
      const { readdirSync } = await import('node:fs');
      expect(readdirSync(CACHE_DIR).some((f) => f.includes(prefix))).toBe(false);
    },
  );

  it('rejects a cap that is not a positive integer', () => {
    expect(() =>
      makeJudge('claude-haiku-5-5', 's', 'p', false, () => ({}), makeCost(), {
        maxOutputTokens: 0,
      }),
    ).toThrow(/positive integer/);
  });
});

/** JUDGE DRAWS RUN STRICTLY ONE AT A TIME (914), even when callers judge in parallel. */
describe('judge draws are serial', () => {
  it('never has two draws in flight, across concurrent judge() calls', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const create = async () => {
      calls += 1;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      // no score: the draw throws and nothing is cached, which is all this test needs
      return {
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't', name: 'score', input: { reason: 'x' } }],
        usage: { input_tokens: 1, output_tokens: 1 },
      };
    };
    const prefix = `judge-serial-${Math.random().toString(36).slice(2)}`;
    const judge = makeJudge(
      'claude-haiku-5-5',
      's',
      prefix,
      false,
      () => ({ messages: { create } }),
      makeCost(),
      { samples: 2 },
    );
    const results = await Promise.allSettled([
      judge('a', { t: 1 }),
      judge('b', { t: 2 }),
      judge('c', { t: 3 }),
    ]);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(maxInFlight).toBe(1);
  });
});
