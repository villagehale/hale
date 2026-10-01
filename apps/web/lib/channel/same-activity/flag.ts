/**
 * VIL-394 — same-activity meet / join-group.
 *
 * Off unless SAME_ACTIVITY_MEET_ENABLED is exactly the string `true`. A
 * trailing newline from `vercel env add`, `TRUE`, `on`, and `1` stay off.
 * Unset stays off. This flag is the only switch that may read another
 * household's opt-in.
 */
export const SAME_ACTIVITY_MEET_ENABLED_ENV = 'SAME_ACTIVITY_MEET_ENABLED';

export function sameActivityMeetEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[SAME_ACTIVITY_MEET_ENABLED_ENV] === 'true';
}
