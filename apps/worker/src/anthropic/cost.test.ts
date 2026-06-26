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
  // Expected values derived from the published rates, NOT from code output:
  // Sonnet 4.6 = $3/MTok in, $15/MTok out. 1M in + 1M out = $3 + $15 = $18.
  it('prices Sonnet at $3 in / $15 out per MTok', () => {
    expect(estimateCostUsd(SONNET_MODEL, usage(1_000_000, 1_000_000))).toBeCloseTo(18, 6);
  });

  // Haiku 4.5 = $1/MTok in, $5/MTok out. 500k in + 200k out = $0.5 + $1.0 = $1.5.
  it('prices Haiku at $1 in / $5 out per MTok', () => {
    expect(estimateCostUsd(HAIKU_MODEL, usage(500_000, 200_000))).toBeCloseTo(1.5, 6);
  });

  it('folds cache-creation tokens into input cost', () => {
    const u = usage(1_000_000, 0);
    u.cache_creation_input_tokens = 1_000_000;
    // 2M input @ $3/MTok = $6.
    expect(estimateCostUsd(SONNET_MODEL, u)).toBeCloseTo(6, 6);
  });

  it('prices cache-read tokens at 0.1x the input rate', () => {
    const u = usage(0, 0);
    u.cache_read_input_tokens = 1_000_000;
    // 1M cache-read @ $3/MTok * 0.1 = $0.30.
    expect(estimateCostUsd(SONNET_MODEL, u)).toBeCloseTo(0.3, 6);
  });

  it('throws on an unpriced model rather than guessing a rate', () => {
    expect(() => estimateCostUsd('claude-unknown-9', usage(1, 1))).toThrow(/no rate configured/);
  });
});
