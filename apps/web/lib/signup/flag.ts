/**
 * VIL-375 — parent-authorized signup.
 *
 * Off unless AUTHORIZED_SIGNUP_ENABLED is exactly `on` after trim. `true`,
 * `1`, and `ON` stay off. Unset stays off.
 */
export const AUTHORIZED_SIGNUP_ENABLED_ENV = 'AUTHORIZED_SIGNUP_ENABLED';

export function authorizedSignupEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env[AUTHORIZED_SIGNUP_ENABLED_ENV] ?? '').trim() === 'on';
}
