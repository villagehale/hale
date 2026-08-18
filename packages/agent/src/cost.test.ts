import { describe, expect, it } from 'vitest';
import { agentRunCostUsd, estimateCostUsd } from './cost.js';
import { HAIKU_MODEL, OPUS_MODEL, SONNET_MODEL } from './model.js';

/**
 * Expected values are derived from the published per-MTok rates and the cache
 * multipliers, never copied from what the code emits:
 *   Sonnet 4.6 $3 in / $15 out · Haiku 4.5 $1 / $5 · Opus 4.8 $5 / $25
 *   cache read = 0.1x input · cache write (5m) = 1.25x input
 */

function tiers(over: Partial<Parameters<typeof estimateCostUsd>[1]> = {}) {
  return {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    ...over,
  };
}

describe('estimateCostUsd', () => {
  it('prices each tier at its published base rate', () => {
    // 1M in + 1M out: Sonnet $3 + $15 = $18; Haiku $1 + $5 = $6; Opus $5 + $25 = $30.
    const million = tiers({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(estimateCostUsd(SONNET_MODEL, million)).toBeCloseTo(18, 6);
    expect(estimateCostUsd(HAIKU_MODEL, million)).toBeCloseTo(6, 6);
    expect(estimateCostUsd(OPUS_MODEL, million)).toBeCloseTo(30, 6);
  });

  it('bills cache writes at 1.25x the input rate', () => {
    // 1M cache-creation on Sonnet = $3 * 1.25 = $3.75.
    expect(estimateCostUsd(SONNET_MODEL, tiers({ cacheCreationTokens: 1_000_000 }))).toBeCloseTo(
      3.75,
      6,
    );
  });

  it('bills cache reads at 0.1x the input rate', () => {
    // 1M cache-read on Haiku = $1 * 0.1 = $0.10.
    expect(estimateCostUsd(HAIKU_MODEL, tiers({ cacheReadTokens: 1_000_000 }))).toBeCloseTo(0.1, 6);
  });

  it('sums all four tiers for a cached turn', () => {
    // Sonnet: 200*3 + 1024*3*1.25 + 5303*3*0.1 + 90*15 = 7380.9 / 1e6.
    const cost = estimateCostUsd(
      SONNET_MODEL,
      tiers({
        inputTokens: 200,
        cacheCreationTokens: 1024,
        cacheReadTokens: 5303,
        outputTokens: 90,
      }),
    );
    expect(cost).toBeCloseTo(0.0073809, 9);
  });

  it('throws on an unpriced model rather than guessing a rate', () => {
    expect(() => estimateCostUsd('claude-unknown-9', tiers({ inputTokens: 1 }))).toThrow(
      /no rate configured/,
    );
  });
});

describe('agentRunCostUsd', () => {
  it('splits promptTokens into its full-rate and cache-write slices', () => {
    // Same turn as above, in AgentUsage shape: promptTokens carries fresh input
    // (200) AND the cache write (1024), so only the 1024 gets the 1.25x premium.
    const cost = agentRunCostUsd(SONNET_MODEL, {
      promptTokens: 1224,
      cacheCreationTokens: 1024,
      cacheReadTokens: 5303,
      completionTokens: 90,
    });
    expect(cost).toBeCloseTo(0.0073809, 9);
  });
});
