import type { RateLimitOptions } from './limiter';

/**
 * Per-route caps for the abuse-prone endpoints. Keyed by a stable route label
 * (also the `route` column value), so the limit and the limited surface live in
 * one place. The two LLM-backed coach routes are capped per signed-in user (cost
 * abuse); the inbound ingest webhook is capped per source family (flooding).
 */
export const RATE_LIMITS = {
  coach: { limit: 30, windowSec: 60 },
  'coach-action': { limit: 30, windowSec: 60 },
  ingest: { limit: 60, windowSec: 60 },
} as const satisfies Record<string, RateLimitOptions>;

export type RateLimitRoute = keyof typeof RATE_LIMITS;
