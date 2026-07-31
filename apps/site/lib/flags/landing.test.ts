import { describe, expect, it, vi } from 'vitest';
import { F14_LANDING_ENV, f14LandingEnabled } from './landing.js';

/**
 * The pivot replaces the entire public homepage, so its gate has to fail closed
 * on every shape that is not exactly the armed literal — including the trailing
 * newline `vercel env add` stores when the value is piped in from `echo`.
 */
describe('f14LandingEnabled', () => {
  it('is off when the variable is unset', () => {
    vi.stubEnv(F14_LANDING_ENV, '');
    expect(f14LandingEnabled()).toBe(false);
  });

  it('is on only for the exact literal', () => {
    vi.stubEnv(F14_LANDING_ENV, 'true');
    expect(f14LandingEnabled()).toBe(true);
  });

  it('stays off for a stored trailing newline, whitespace, or a truthy near-miss', () => {
    for (const value of ['true\n', ' true', 'True', 'TRUE', '1', 'yes', 'false']) {
      vi.stubEnv(F14_LANDING_ENV, value);
      expect(f14LandingEnabled()).toBe(false);
    }
  });

  it('names the flag NEXT_PUBLIC_F14_LANDING', () => {
    expect(F14_LANDING_ENV).toBe('NEXT_PUBLIC_F14_LANDING');
  });
});
