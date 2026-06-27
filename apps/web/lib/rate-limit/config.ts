import type { RateLimitOptions } from './limiter';

/**
 * Per-route caps for the abuse-prone endpoints. Keyed by a stable route label
 * (also the `route` column value), so the limit and the limited surface live in
 * one place. The two LLM-backed coach routes are capped per signed-in user (cost
 * abuse); the inbound ingest webhook is capped per source family (flooding).
 *
 * These are deliberately GENEROUS — a silent guard against bots and runaway
 * loops, NEVER a wall a real family hits. Each is set well above the realistic
 * peak so a 99th-percentile human stays clear; only a script trips it.
 *
 * - coach / coach-action (60/min/user): each request is a multi-second STREAMED
 *   agent turn, so a parent physically taps at most a handful per minute even in
 *   an intense back-and-forth (~5-10). 60 is ~6-12x that peak — unreachable by
 *   hand, so only an automated loop crosses it.
 * - ingest (120/min/source): a real per-family forwarder (email/calendar)
 *   delivers a handful of signals a minute even on a busy day; a flood is
 *   hundreds. 120 sits far above legitimate traffic yet well under a flood, so it
 *   stops the flood without ever throttling a real source.
 */
export const RATE_LIMITS = {
  coach: { limit: 60, windowSec: 60 },
  'coach-action': { limit: 60, windowSec: 60 },
  ingest: { limit: 120, windowSec: 60 },
} as const satisfies Record<string, RateLimitOptions>;

export type RateLimitRoute = keyof typeof RATE_LIMITS;
