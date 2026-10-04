/**
 * VIL-385 — value-first first touch.
 *
 * Off unless FIRST_TOUCH_LADDER_ENABLED is exactly `on` after trim. `true`,
 * `1`, and `ON` stay off. Unset stays off. The ladder is new/unknown parents
 * only; a session already on it keeps going if the flag later flips.
 */
export const FIRST_TOUCH_LADDER_ENABLED_ENV = 'FIRST_TOUCH_LADDER_ENABLED';

/**
 * VIL-412. Linq location sharing is a paid add-on and stays off.
 * On only when FIRST_TOUCH_LOCATION_CARD_ENABLED is exactly `true`.
 * No trim: `TRUE`, `on`, `1`, and `true\n` stay off. Unset stays off.
 */
export const FIRST_TOUCH_LOCATION_CARD_ENABLED_ENV = 'FIRST_TOUCH_LOCATION_CARD_ENABLED';

export function firstTouchLadderEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env[FIRST_TOUCH_LADDER_ENABLED_ENV] ?? '').trim() === 'on';
}

export function firstTouchLocationCardEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[FIRST_TOUCH_LOCATION_CARD_ENABLED_ENV] === 'true';
}
