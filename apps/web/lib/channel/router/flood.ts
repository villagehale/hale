import { RATE_LIMITS } from '~/lib/rate-limit/config';

/**
 * VIL-220 · C1 — flood control for AGENT turns.
 *
 * The budget itself lives in `RATE_LIMITS` with every other per-route cap, so the
 * limited surface and its number stay in one place; this module only names the route
 * and re-exports the count for the copy and the tests to reason about. Why the cap is
 * set where it is, and why it is separate from M2's per-number `sms-inbound` cap, is
 * documented alongside the number.
 */

/** The limiter route label, also the `route` column value. Keyed per PARENT: this
 * guards the agent, which belongs to a person, not the channel. */
export const AGENT_TURN_ROUTE = 'sms-agent-turn';

export const AGENT_TURN_LIMIT = RATE_LIMITS[AGENT_TURN_ROUTE];

export const AGENT_TURNS_PER_HOUR = AGENT_TURN_LIMIT.limit;
