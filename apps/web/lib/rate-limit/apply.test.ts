import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientIp, enforceRateLimit, setRateLimiterForTesting } from './apply';
import type { RateLimiter } from './limiter';

// db() is never reached: every test injects a limiter, so the cached default
// (which would call db()) is bypassed. Stubbed so the import graph is satisfied.
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

function fixedLimiter(result: { allowed: boolean; retryAfterSec: number }): RateLimiter {
  return { check: vi.fn().mockResolvedValue(result) };
}

afterEach(() => {
  setRateLimiterForTesting(undefined);
  vi.restoreAllMocks();
});

describe('enforceRateLimit', () => {
  it('returns null (proceed) when under the cap', async () => {
    setRateLimiterForTesting(fixedLimiter({ allowed: true, retryAfterSec: 30 }));

    expect(await enforceRateLimit('coach', 'user-a')).toBeNull();
  });

  it('returns 429 with a Retry-After header when over the cap', async () => {
    setRateLimiterForTesting(fixedLimiter({ allowed: false, retryAfterSec: 42 }));

    const res = await enforceRateLimit('coach', 'user-a');

    expect(res?.status).toBe(429);
    expect(res?.headers.get('Retry-After')).toBe('42');
  });

  it('fails open (returns null) when the limiter throws', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    setRateLimiterForTesting({ check: vi.fn().mockRejectedValue(new Error('db down')) });

    expect(await enforceRateLimit('coach', 'user-a')).toBeNull();
    expect(consoleErr).toHaveBeenCalled();
  });

  it('fails CLOSED (returns 429) when the limiter throws and failClosed is set', async () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});
    setRateLimiterForTesting({ check: vi.fn().mockRejectedValue(new Error('db down')) });

    const res = await enforceRateLimit('auth', '203.0.113.7', true);

    expect(res?.status).toBe(429);
    expect(consoleErr).toHaveBeenCalled();
  });
});

describe('clientIp', () => {
  it('takes the first hop of x-forwarded-for', () => {
    const req = new Request('http://localhost', {
      headers: { 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' },
    });

    expect(clientIp(req)).toBe('203.0.113.7');
  });

  it('falls back to a fixed key when the header is absent', () => {
    expect(clientIp(new Request('http://localhost'))).toBe('unknown');
  });
});
