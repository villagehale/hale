/**
 * Same predicates as apps/web/lib/channel/intake/first-touch-flag.ts.
 * The /text preview reads them so the bubble matches the first message Hale
 * sends when the ladder is on.
 */
export function firstTouchLadderEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.FIRST_TOUCH_LADDER_ENABLED ?? '').trim() === 'on';
}

/** Exact `true`, no trim. Unset, on, 1, TRUE, and `true\n` stay off. */
export function firstTouchLocationCardEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.FIRST_TOUCH_LOCATION_CARD_ENABLED === 'true';
}
