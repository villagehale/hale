/**
 * VIL-79 — mention a kid-schedule overlap before the parent confirms an add or move.
 *
 * Off unless KID_CLASH_NOTICE_ENABLED is exactly `true`. A trailing newline from
 * `vercel env add` stays off. Unset stays off. Not preview-only: production may
 * set it after deploy. There is no allowlist and no VERCEL_ENV hard-off.
 */

export const KID_CLASH_NOTICE_ENABLED_ENV = 'KID_CLASH_NOTICE_ENABLED';

export function kidClashNoticeEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[KID_CLASH_NOTICE_ENABLED_ENV] === 'true';
}
