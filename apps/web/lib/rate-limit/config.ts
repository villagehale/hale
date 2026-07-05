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
 * - auth (20/min/IP): sign-in + sign-up share one per-IP window. A human signs in
 *   or registers a handful of times a minute even fumbling a password; 20 is far
 *   above that yet blunts password brute-force / signup spam from one source.
 * - preview (10/min/IP): the pre-auth value preview is an UNAUTHENTICATED, LLM-
 *   backed call (cost abuse), so it is capped per source IP — the only identifier
 *   available before sign-in. A curious visitor re-runs it a few times tweaking
 *   age/area/interests; 10/min sits well above that yet stops a scripted loop from
 *   running up spend on an open endpoint.
 * - village-search (5/hour/family): the ONE genuine cooldown here, not a silent bot
 *   guard. Each search triggers a billable LLM discovery a parent explicitly asks
 *   for, so it is capped per family on an HOUR window. Trying all four seasons plus
 *   a couple of re-runs is 5-6; five per hour covers honest exploration while
 *   blunting a parent (or a script) hammering paid runs. Per-family (not per-user)
 *   because the run and its cost belong to the family, not one parent.
 */
export const RATE_LIMITS = {
  coach: { limit: 60, windowSec: 60 },
  'coach-action': { limit: 60, windowSec: 60 },
  ingest: { limit: 120, windowSec: 60 },
  auth: { limit: 20, windowSec: 60 },
  preview: { limit: 10, windowSec: 60 },
  'village-search': { limit: 5, windowSec: 3600 },
} as const satisfies Record<string, RateLimitOptions>;

export type RateLimitRoute = keyof typeof RATE_LIMITS;
