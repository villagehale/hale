import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { estimateCostUsd } from './cost.js';
import { HAIKU_MODEL, SONNET_MODEL } from './client.js';

function usage(input: number, output: number): Anthropic.Usage {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    server_tool_use: null,
  };
}

describe('estimateCostUsd', () => {
  // Expected values derived from the published rates (pricing page, 2026-10-11), NOT
  // from code output.
  // Sonnet 5.5 = $2/MTok in, $10/MTok out. 1M in + 1M out = $2 + $10 = $12.
  it('prices Sonnet 5.5 at $2 in / $10 out per MTok', () => {
    expect(estimateCostUsd(SONNET_MODEL, usage(1_000_000, 1_000_000))).toBeCloseTo(12, 6);
  });

  // Haiku 5.5, prompt ≤100K = $0.10/MTok in, $0.50/MTok out. 50k in + 200k out = $0.105.
  it('prices Haiku 5.5 at $0.10 in / $0.50 out per MTok on a short prompt', () => {
    expect(estimateCostUsd(HAIKU_MODEL, usage(50_000, 200_000))).toBeCloseTo(0.105, 6);
  });

  it('prices cache-creation tokens at 1.25x the input rate', () => {
    const u = usage(1_000_000, 0);
    u.cache_creation_input_tokens = 1_000_000;
    // 1M fresh @ $2/MTok + 1M cache-write @ $2 * 1.25 = $2 + $2.50 = $4.50.
    expect(estimateCostUsd(SONNET_MODEL, u)).toBeCloseTo(4.5, 6);
  });

  it('prices Sonnet 5.5 cache reads at the published $0.10/MTok', () => {
    const u = usage(0, 0);
    u.cache_read_input_tokens = 1_000_000;
    expect(estimateCostUsd(SONNET_MODEL, u)).toBeCloseTo(0.1, 6);
  });

  it('throws on an unpriced model rather than guessing a rate', () => {
    expect(() => estimateCostUsd('claude-unknown-9', usage(1, 1))).toThrow(/no rate configured/);
  });
});
