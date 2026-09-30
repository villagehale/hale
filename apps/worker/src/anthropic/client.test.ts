import { describe, expect, it } from 'vitest';
import { ANTHROPIC_MAX_RETRIES, ANTHROPIC_TIMEOUT_MS } from './client.js';

describe('worker Anthropic client budget', () => {
  it('states a timeout under the function wall and a single retry', () => {
    expect(ANTHROPIC_TIMEOUT_MS).toBe(60_000);
    expect(ANTHROPIC_MAX_RETRIES).toBe(1);
    expect(ANTHROPIC_TIMEOUT_MS).toBeLessThan(800_000);
  });
});
