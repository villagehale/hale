import type Anthropic from '@anthropic-ai/sdk';
import { HAIKU_MODEL } from '@hale/agent';
import { describe, expect, it } from 'vitest';
import { metricsFromUsage } from './run-metrics.js';

describe('metricsFromUsage', () => {
  it('keeps cache reads out of promptTokens and carries both cache counts on their own', () => {
    const usage = {
      input_tokens: 100,
      cache_creation_input_tokens: 50,
      cache_read_input_tokens: 400,
      output_tokens: 20,
    } as Anthropic.Usage;

    const metrics = metricsFromUsage('classifier', HAIKU_MODEL, usage, 1200);

    expect(metrics.promptTokens).toBe(150);
    expect(metrics.cacheReadTokens).toBe(400);
    expect(metrics.cacheWriteTokens).toBe(50);
  });
});
