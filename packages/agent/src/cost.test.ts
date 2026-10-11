import { describe, expect, it } from 'vitest';
import { agentRunCostUsd, estimateCostUsd } from './cost.js';
import { DEEPSEEK_MODEL, HAIKU_MODEL, OPUS_MODEL, SONNET_MODEL } from './model.js';

/**
 * Expected values are derived from the published per-MTok rates
 * (platform.claude.com/docs/en/about-claude/pricing, read 2026-10-11), never copied
 * from what the code emits:
 *   Sonnet 5.5 $2 in / $10 out, cache read $0.10 (0.05x), 5m write $2.50 (1.25x)
 *   Opus 5.5 $4 / $20, cache read $0.20 (0.05x), 5m write $5
 *   Haiku 5.5, prompt ≤100K tokens: $0.10 / $0.50, read $0.01, write $0.125
 *   Haiku 5.5, prompt >100K tokens: $0.50 / $2.50, read $0.05, write $0.625
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
    // 50K in + 1M out: Sonnet 5.5 = 0.1 + 10; Opus 5.5 = 0.2 + 20; Haiku 5.5 = 0.005 + 0.5.
    const short = tiers({ inputTokens: 50_000, outputTokens: 1_000_000 });
    expect(estimateCostUsd(SONNET_MODEL, short)).toBeCloseTo(10.1, 6);
    expect(estimateCostUsd(OPUS_MODEL, short)).toBeCloseTo(20.2, 6);
    expect(estimateCostUsd(HAIKU_MODEL, short)).toBeCloseTo(0.505, 6);
    const million = tiers({ inputTokens: 1_000_000, outputTokens: 1_000_000 });
    expect(estimateCostUsd(DEEPSEEK_MODEL, million)).toBeCloseTo(0.75, 6);
  });

  it('moves a Haiku 5.5 call to the long-prompt card above 100K prompt tokens', () => {
    // The prompt is every input token, cache reads and writes included: 100K exactly is
    // the short card, one token more is the long one for the WHOLE call.
    expect(
      estimateCostUsd(HAIKU_MODEL, tiers({ inputTokens: 100_000, outputTokens: 1_000 })),
    ).toBeCloseTo(0.01 + 0.0005, 9);
    expect(
      estimateCostUsd(
        HAIKU_MODEL,
        tiers({ inputTokens: 1, cacheReadTokens: 100_000, outputTokens: 1_000 }),
      ),
    ).toBeCloseTo(0.0000005 + 0.005 + 0.0025, 9);
  });

  it('bills cache writes at 1.25x the input rate', () => {
    // 1M cache-creation on Sonnet 5.5 = $2 * 1.25 = $2.50.
    expect(estimateCostUsd(SONNET_MODEL, tiers({ cacheCreationTokens: 1_000_000 }))).toBeCloseTo(
      2.5,
      6,
    );
  });

  it('bills cache reads at the published per-model rate', () => {
    // 50K cache-read: Sonnet 5.5 $0.10/M, Opus 5.5 $0.20/M, Haiku 5.5 $0.01/M.
    const reads = tiers({ cacheReadTokens: 50_000 });
    expect(estimateCostUsd(SONNET_MODEL, reads)).toBeCloseTo(0.005, 9);
    expect(estimateCostUsd(OPUS_MODEL, reads)).toBeCloseTo(0.01, 9);
    expect(estimateCostUsd(HAIKU_MODEL, reads)).toBeCloseTo(0.0005, 9);
  });

  it('uses the Gateway cached-input rate for DeepSeek', () => {
    expect(estimateCostUsd(DEEPSEEK_MODEL, tiers({ cacheReadTokens: 1_000_000 }))).toBeCloseTo(
      0.003,
      6,
    );
  });

  it('sums all four tiers for a cached turn', () => {
    // Sonnet 5.5: 200*2 + 1024*2.5 + 5303*0.1 + 90*10 = 4390.3 / 1e6.
    const cost = estimateCostUsd(
      SONNET_MODEL,
      tiers({
        inputTokens: 200,
        cacheCreationTokens: 1024,
        cacheReadTokens: 5303,
        outputTokens: 90,
      }),
    );
    expect(cost).toBeCloseTo(0.0043903, 9);
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
    expect(cost).toBeCloseTo(0.0043903, 9);
  });
});
