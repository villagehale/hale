/**
 * Same predicate as apps/web/lib/channel/intake/first-touch-flag.ts.
 * The /text preview reads it so the bubble matches the first message Hale
 * sends when the ladder is on. Unset, true, 1, and ON stay off.
 */
export function firstTouchLadderEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.FIRST_TOUCH_LADDER_ENABLED ?? '').trim() === 'on';
}
