import type { RateLimiter, RateLimitOptions, RateLimitResult } from './limiter';

/**
 * In-memory fixed-window limiter for tests. Mirrors the Postgres impl's window
 * math so a test that passes here describes the real contract: the window is the
 * floor of `now / windowSec`, and the count resets when the window rolls over.
 * `now()` is injectable so tests can advance time deterministically.
 */
export class FakeRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, { windowStart: number; count: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async check(key: string, route: string, opts: RateLimitOptions): Promise<RateLimitResult> {
    const windowMs = opts.windowSec * 1000;
    const windowStart = Math.floor(this.now() / windowMs) * windowMs;
    const mapKey = JSON.stringify([key, route]);

    const existing = this.counts.get(mapKey);
    const count = existing && existing.windowStart === windowStart ? existing.count + 1 : 1;
    this.counts.set(mapKey, { windowStart, count });

    const retryAfterSec = Math.ceil((windowStart + windowMs - this.now()) / 1000);
    return { allowed: count <= opts.limit, retryAfterSec };
  }
}
