/**
 * VIL-385 — value-first first touch.
 *
 * Off unless FIRST_TOUCH_LADDER_ENABLED is exactly `on` after trim. `true`,
 * `1`, and `ON` stay off. Unset stays off. The ladder is new/unknown parents
 * only; a session already on it keeps going if the flag later flips.
 */
export const FIRST_TOUCH_LADDER_ENABLED_ENV = 'FIRST_TOUCH_LADDER_ENABLED';

export function firstTouchLadderEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env[FIRST_TOUCH_LADDER_ENABLED_ENV] ?? '').trim() === 'on';
}
