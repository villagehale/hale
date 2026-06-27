/** A fixed-window rate-limit decision for one (key, route) pair. */
export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the current window expires; for the `Retry-After` header. */
  retryAfterSec: number;
}

export interface RateLimitOptions {
  /** Max requests permitted within one window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

/**
 * Counts a request against a fixed window and decides whether to allow it. Behind
 * an interface so routes depend on the contract, not Postgres — the Postgres impl
 * runs in production, the Fake runs in tests (no DB). A failing limiter is the
 * CALLER's concern (fail-open lives in the route helper), so `check` may throw.
 */
export interface RateLimiter {
  check(key: string, route: string, opts: RateLimitOptions): Promise<RateLimitResult>;
}
