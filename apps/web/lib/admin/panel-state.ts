import type { ServiceOutcome } from './services/outcome';

/**
 * The one vocabulary for a degraded panel (rule #11 rendered): a missing key
 * names itself, a dead provider says it didn't answer, and neither is ever a
 * blank. Pure, so the copy is testable without rendering.
 */
export function serviceStateLine(
  provider: string,
  outcome: Extract<ServiceOutcome<unknown>, { ok: false }>,
): string {
  if (outcome.status === 'not_configured') {
    return `${outcome.detail}.`;
  }
  return `${provider} didn’t answer (${outcome.detail}) — the link below still works.`;
}

export const EMPTY_WINDOW_LINE = 'No rows in this window.';

/** Radar honesty: a verify sweep older than this reads as stale (amber chip). */
export const STALE_VERIFY_DAYS = 7;

/**
 * Watched-spots honesty: three missed 10-minute sweep ticks. Distinct from
 * STALE_VERIFY_DAYS, which is about a registration window's source verification —
 * this one is about a course page nobody has REACHED.
 */
export const STALE_POLL_MINUTES = 30;

/** Whole minutes between a UTC stamp and `now`. A stamp in the future reads as 0:
 * Postgres's clock running ahead of the render host is skew, not an age. */
export function minutesAgo(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000));
}
