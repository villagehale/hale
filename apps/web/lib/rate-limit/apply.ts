import { NextResponse } from 'next/server';
import { db } from '~/lib/db';
import { captureException } from '~/lib/monitoring/sentry';
import { RATE_LIMITS, type RateLimitRoute } from './config';
import type { RateLimiter } from './limiter';
import { PostgresRateLimiter } from './postgres';

let cached: RateLimiter | undefined;

function limiter(): RateLimiter {
  if (!cached) cached = new PostgresRateLimiter(db());
  return cached;
}

/** Override the limiter (tests inject a Fake; reset with `undefined`). */
export function setRateLimiterForTesting(rl: RateLimiter | undefined): void {
  cached = rl;
}

/**
 * The client IP for an unauthed caller. On Vercel the real client is the FIRST
 * hop of `x-forwarded-for` (subsequent hops are Vercel's own proxies); the header
 * is comma-separated. No header (e.g. a local call) → a fixed key so the limit
 * still applies rather than letting every header-less request through free.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() || 'unknown';
}

/**
 * Enforce the per-route cap for `identifier`. Returns a 429 `Response` (with
 * `Retry-After`) when over the cap, or `null` to proceed. FAILS OPEN: a broken
 * limiter must never block legitimate users, so any limiter error is reported and
 * the request is allowed. Each route passes its own already-resolved identifier
 * (a user id for authed routes, a client IP for unauthed) so this helper never
 * has to know how a route authenticates.
 */
export async function enforceRateLimit(
  route: RateLimitRoute,
  identifier: string,
): Promise<Response | null> {
  try {
    const result = await limiter().check(identifier, route, RATE_LIMITS[route]);
    if (result.allowed) return null;

    return NextResponse.json(
      { error: 'rate_limited' },
      { status: 429, headers: { 'Retry-After': String(result.retryAfterSec) } },
    );
  } catch (err) {
    captureException(err);
    console.error({ err, route }, 'rate-limit check failed — failing open');
    return null;
  }
}
