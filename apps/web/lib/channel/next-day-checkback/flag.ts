/**
 * VIL-681 — one next-day check-back on an unfinished parent ask (an unpicked
 * find, an unapproved registration). Queued for the proactive decider; the
 * model writes the line. A miss sends nothing.
 *
 * A kill switch: on unless NEXT_DAY_CHECKBACK_ENABLED is `false` (trimmed).
 * Unset stays on. There is no allowlist.
 */
import { isEnabled } from '@hale/flags';

export const NEXT_DAY_CHECKBACK_ENABLED_ENV = 'NEXT_DAY_CHECKBACK_ENABLED';

export function nextDayCheckbackEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('next-day-checkback', undefined, env);
}
