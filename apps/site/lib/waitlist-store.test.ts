import { describe, expect, it, vi } from 'vitest';
import {
  createRateLimiter,
  extractClientIp,
  type RateLimitCounter,
} from './waitlist-store.js';

// A fake counter backed by an in-memory map, mirroring redis INCR semantics
// (returns the value AFTER incrementing). expire is recorded but not enforced.
function fakeCounter() {
  const counts = new Map<string, number>();
  const expire = vi.fn().mockResolvedValue(1);
  const incr = vi.fn(async (key: string) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next;
  });
  return { counter: { incr, expire } satisfies RateLimitCounter, incr, expire };
}

describe('createRateLimiter', () => {
  it('allows the first five hits and blocks the sixth within a window', async () => {
    const { counter } = fakeCounter();
    const limiter = createRateLimiter(counter);

    const verdicts = [];
    for (let i = 0; i < 6; i += 1) {
      verdicts.push((await limiter.check('1.2.3.4')).allowed);
    }

    expect(verdicts).toEqual([true, true, true, true, true, false]);
  });

  it('sets the window TTL only on the first hit', async () => {
    const { counter, expire } = fakeCounter();
    const limiter = createRateLimiter(counter);

    await limiter.check('1.2.3.4');
    await limiter.check('1.2.3.4');
    await limiter.check('1.2.3.4');

    expect(expire).toHaveBeenCalledTimes(1);
    expect(expire).toHaveBeenCalledWith('hearth:waitlist:rl:1.2.3.4', 3600);
  });

  it('tracks each IP in its own bucket', async () => {
    const { counter } = fakeCounter();
    const limiter = createRateLimiter(counter);

    for (let i = 0; i < 5; i += 1) await limiter.check('1.1.1.1');

    expect((await limiter.check('1.1.1.1')).allowed).toBe(false);
    expect((await limiter.check('2.2.2.2')).allowed).toBe(true);
  });
});

describe('extractClientIp', () => {
  it('takes the RIGHTMOST x-forwarded-for entry (the trusted-proxy hop), not the spoofable leftmost', () => {
    // A client can prepend forged entries; only the rightmost (203.0.113.7,
    // appended by our proxy) is trustworthy. The leftmost (1.1.1.1) is attacker-set.
    const headers = new Headers({ 'x-forwarded-for': '1.1.1.1, 70.41.3.18, 203.0.113.7' });
    expect(extractClientIp(headers)).toBe('203.0.113.7');
  });

  it('prefers the platform header x-vercel-forwarded-for over x-forwarded-for', () => {
    const headers = new Headers({
      'x-vercel-forwarded-for': '203.0.113.7',
      'x-forwarded-for': '1.1.1.1, 203.0.113.7',
    });
    expect(extractClientIp(headers)).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip when no x-forwarded-for is present', () => {
    const headers = new Headers({ 'x-real-ip': '198.51.100.9' });
    expect(extractClientIp(headers)).toBe('198.51.100.9');
  });

  it('returns "unknown" when no IP header is present', () => {
    expect(extractClientIp(new Headers())).toBe('unknown');
  });
});
