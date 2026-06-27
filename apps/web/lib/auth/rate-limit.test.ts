import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeRateLimiter } from '~/lib/rate-limit/fake';
import { setRateLimiterForTesting } from '~/lib/rate-limit/apply';
import { RATE_LIMITS } from '~/lib/rate-limit/config';

// authRateLimited reads the request IP via next/headers; stub it so the test
// controls the caller IP. db() is never reached (the limiter is injected).
const headerStore = new Map<string, string>();
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (k: string) => headerStore.get(k) ?? null }),
}));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

import { authRateLimited } from './rate-limit';

afterEach(() => {
  setRateLimiterForTesting(undefined);
  headerStore.clear();
  vi.restoreAllMocks();
});

/**
 * authRateLimited is the SHARED brute-force guard wired into BOTH auth entry
 * points (the Credentials authorize chokepoint and the sign-up action). These
 * tests prove it blocks once over the per-IP cap and fails CLOSED on a limiter
 * outage — the property that protects the direct /api/auth/callback/credentials
 * path, not just the form.
 */
describe('authRateLimited', () => {
  it('allows up to the auth cap, then blocks the same IP', async () => {
    setRateLimiterForTesting(new FakeRateLimiter());
    headerStore.set('x-forwarded-for', '203.0.113.7');

    const cap = RATE_LIMITS.auth.limit;
    for (let i = 0; i < cap; i++) {
      expect(await authRateLimited()).toBe(false);
    }
    // The (cap + 1)th attempt from this IP is over the window and blocked.
    expect(await authRateLimited()).toBe(true);
  });

  it('fails CLOSED (blocks) when the limiter throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setRateLimiterForTesting({ check: vi.fn().mockRejectedValue(new Error('db down')) });
    headerStore.set('x-forwarded-for', '203.0.113.7');

    expect(await authRateLimited()).toBe(true);
  });

  it('keys on the first hop of x-forwarded-for, falling back to a fixed key', async () => {
    const limiter = new FakeRateLimiter();
    const spy = vi.spyOn(limiter, 'check');
    setRateLimiterForTesting(limiter);

    headerStore.set('x-forwarded-for', '203.0.113.7, 70.41.3.18');
    await authRateLimited();
    expect(spy).toHaveBeenLastCalledWith('203.0.113.7', 'auth', RATE_LIMITS.auth);

    headerStore.clear();
    await authRateLimited();
    expect(spy).toHaveBeenLastCalledWith('unknown', 'auth', RATE_LIMITS.auth);
  });
});
