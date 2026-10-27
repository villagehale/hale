import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_CACHE_TTL_MS,
  resetPromptCacheState,
} from '../../../web/lib/testing/spend-cap.mjs';
import { projectAgentTurn } from './agent-dry-plan.mjs';

const rates = () => ({ input: 2, output: 10 });
const marked = {
  model: 'm',
  max_tokens: 400,
  system: [{ type: 'text', text: 'skill', cache_control: { type: 'ephemeral' } }],
  tools: [],
  messages: [{ role: 'user', content: 'hi' }],
};
// Deterministic token counts: whole request 20k, system+tools prefix 18k.
const estimate = (r) => (r.messages ? 20_000 : 18_000);
const base = { rates, estimate, maxSteps: 6, growthTokens: 1500, tag: 't' };

describe('projectAgentTurn', () => {
  beforeEach(() => resetPromptCacheState());

  it('prices the first call at the full cache-write rate, later steps read the prefix', () => {
    const rows = projectAgentTurn({ ...base, request: marked, step: 2, now: () => 1000 });
    expect(rows).toHaveLength(5);
    expect(rows[0].cacheReadTokens).toBe(0);
    expect(rows[0].worstUsd).toBeCloseTo((20_000 * 2 * 1.25 + 400 * 10) / 1e6, 8);
    expect(rows[1].cacheReadTokens).toBe(18_000);
    expect(rows[1].worstUsd).toBeCloseTo((18_000 * 2 * 0.1 + 3_500 * 2 * 1.25 + 400 * 10) / 1e6, 8);
  });

  it('a later turn inside the cache window reads the prefix from its first step', () => {
    projectAgentTurn({ ...base, request: marked, step: 6, now: () => 0 });
    const rows = projectAgentTurn({ ...base, request: marked, step: 6, now: () => 60_000 });
    expect(rows[0].cacheReadTokens).toBe(18_000);
  });

  it('no discount once the cache window (minus margin) has passed', () => {
    projectAgentTurn({ ...base, request: marked, step: 6, now: () => 0 });
    const rows = projectAgentTurn({
      ...base,
      request: marked,
      step: 6,
      now: () => DEFAULT_CACHE_TTL_MS,
    });
    expect(rows[0].cacheReadTokens).toBe(0);
  });

  it('never discounts a request whose system prompt is not cache-marked', () => {
    const plain = { ...marked, system: 'skill' };
    const rows = projectAgentTurn({ ...base, request: plain, step: 2, now: () => 0 });
    expect(rows.every((r) => r.cacheReadTokens === 0)).toBe(true);
    expect(rows[0].worstUsd).toBeCloseTo((20_000 * 2 + 400 * 10) / 1e6, 8);
  });
});
