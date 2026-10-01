/**
 * VIL-393 — one mid-activity ask, then the answer joins this household's next find.
 *
 * Off unless MID_ACTIVITY_ASK_ENABLED is exactly `true`. A trailing newline from
 * `vercel env add` stays off. Unset stays off. There is no allowlist: fewer asks
 * is the default, and a dark global flag is the only way this lane wakes up.
 */

export const MID_ACTIVITY_ASK_ENABLED_ENV = 'MID_ACTIVITY_ASK_ENABLED';

export function midActivityAskEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[MID_ACTIVITY_ASK_ENABLED_ENV] === 'true';
}
