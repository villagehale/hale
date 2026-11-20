/**
 * VIL-392 — cold-start ladder flags.
 *
 * Each one is off unless the value is exactly `true`. No trim: `TRUE` and
 * `true\n` stay off. FIRST_TOUCH_LADDER_ENABLED is a different flag and still
 * means exactly `on` after trim.
 */
import { isEnabled } from '@hale/flags';

export const COLD_START_LADDER_ENABLED_ENV = 'COLD_START_LADDER_ENABLED';

export function coldStartLadderEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('cold-start-ladder', undefined, env);
}
