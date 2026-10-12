import { HAIKU_MODEL, JUDGE_MODEL, OPUS_MODEL, SONNET_MODEL } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { cachedToolCall, judgeLaneFor, makeCost, readJudgeModel } from './harness.mjs';

/**
 * WHO GRADES, AND ON WHICH LANE.
 *
 * The judge model and the judge lane are part of every verdict's cache key in spirit
 * but not all of it in fact: `makeJudge` keys on the model id alone. So a judge that
 * drifts back onto the subject's own tier, or onto a thinking shape the tier rejects,
 * would show up only as a cache miss in CI — or, for the lane, not at all.
 */
describe('the eval grader', () => {
  it("reads 'sonnet' as JUDGE_MODEL, never the Sonnet subject tier", async () => {
    const judge = await readJudgeModel('sonnet');
    expect(judge).toBe(JUDGE_MODEL);
    expect(judge).not.toBe(SONNET_MODEL);
  });

  it('defaults to the Haiku tier', async () => {
    expect(await readJudgeModel()).toBe(HAIKU_MODEL);
  });

  it('grades on Haiku with thinking off, and on Opus adaptively (Opus 5.5 cannot turn it off)', async () => {
    expect(await judgeLaneFor(HAIKU_MODEL)).toEqual({
      model: HAIKU_MODEL,
      thinking: 'disabled',
      effort: 'medium',
    });
    expect(await judgeLaneFor(OPUS_MODEL)).toEqual({
      model: OPUS_MODEL,
      thinking: 'adaptive',
      effort: 'medium',
    });
  });
});

/**
 * On the 5.5 generation an omitted `thinking` is not "no thinking" — Haiku 5.5 thinks
 * by default — so a Claude subject recorded from a bare model id is a request
 * production never sends. The harness refuses it before any call is made.
 */
describe('a Claude subject without a lane', () => {
  function clientThatMustNotBeCalled() {
    let calls = 0;
    return {
      calls: () => calls,
      getClient: () => ({
        messages: {
          create: async () => {
            calls += 1;
            throw new Error('the API was reached');
          },
        },
      }),
    };
  }

  const base = {
    system: 'grade it',
    userMessage: 'a turn',
    toolName: 'verdict',
    toolSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
    cachedOnly: false,
  };

  it('is refused before the API is reached', async () => {
    const client = clientThatMustNotBeCalled();
    await expect(
      cachedToolCall({
        ...base,
        tag: `lane-guard-bare-${Math.random().toString(36).slice(2)}`,
        model: SONNET_MODEL,
        getClient: client.getClient,
        cost: makeCost(),
      }),
    ).rejects.toThrow(/pass the subject's lane/);
    expect(client.calls()).toBe(0);
  });

  it('is let through when it names its knobs (positive control)', async () => {
    const client = clientThatMustNotBeCalled();
    await expect(
      cachedToolCall({
        ...base,
        tag: `lane-guard-knobs-${Math.random().toString(36).slice(2)}`,
        model: SONNET_MODEL,
        thinking: { type: 'adaptive' },
        getClient: client.getClient,
        cost: makeCost(),
      }),
    ).rejects.toThrow(/the API was reached/);
    expect(client.calls()).toBe(1);
  });
});
