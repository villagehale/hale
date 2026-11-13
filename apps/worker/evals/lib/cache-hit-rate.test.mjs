import { describe, expect, it } from 'vitest';
import { cacheHitRate, formatCacheHitRates, makeCost, noteUsage } from './harness.mjs';

describe('eval cache hit rate', () => {
  it('is cache_read / (cache_read + cache_creation + input)', () => {
    expect(
      cacheHitRate({
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 10,
        input_tokens: 10,
      }),
    ).toBe(0.8);
    expect(cacheHitRate({ input_tokens: 0 })).toBeNull();
  });

  it('prints one line per call site on the cost object', () => {
    const cost = makeCost();
    noteUsage(
      cost,
      'claude-haiku-5-5',
      { input_tokens: 10, cache_creation_input_tokens: 10, cache_read_input_tokens: 80 },
      'coach',
    );
    noteUsage(
      cost,
      'claude-haiku-5-5',
      { input_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      'judge',
    );
    expect(formatCacheHitRates(cost)).toEqual([
      'cache hit | site=coach read=80 create=10 input=10 rate=0.8000',
      'cache hit | site=judge read=0 create=0 input=50 rate=0.0000',
    ]);
  });
});
