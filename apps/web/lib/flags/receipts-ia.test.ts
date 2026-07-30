import { describe, expect, it, vi } from 'vitest';
import { RECEIPTS_IA_ENV, receiptsIaEnabled } from './receipts-ia';

/**
 * The IA reframe is a whole-app change, so its gate has to fail closed on every
 * shape that is not exactly the armed literal — including the trailing newline
 * `vercel env add` stores when the value is piped in from `echo`.
 */
describe('receiptsIaEnabled', () => {
  it('is off when the variable is unset', () => {
    vi.stubEnv(RECEIPTS_IA_ENV, '');
    expect(receiptsIaEnabled()).toBe(false);
  });

  it('is on only for the exact literal', () => {
    vi.stubEnv(RECEIPTS_IA_ENV, 'true');
    expect(receiptsIaEnabled()).toBe(true);
  });

  it('stays off for a stored trailing newline, whitespace, or a truthy near-miss', () => {
    for (const value of ['true\n', ' true', 'True', 'TRUE', '1', 'yes', 'false']) {
      vi.stubEnv(RECEIPTS_IA_ENV, value);
      expect(receiptsIaEnabled()).toBe(false);
    }
  });

  it('names the flag F14_RECEIPTS_IA, with no NEXT_PUBLIC_ prefix (server-read only)', () => {
    expect(RECEIPTS_IA_ENV).toBe('F14_RECEIPTS_IA');
  });
});
