/**
 * VIL-375 — parent-authorized signup.
 *
 * Off unless AUTHORIZED_SIGNUP_ENABLED is exactly `on` after trim. `true`,
 * `1`, and `ON` stay off. Unset stays off.
 */
import { isEnabled } from '@hale/flags';

export const AUTHORIZED_SIGNUP_ENABLED_ENV = 'AUTHORIZED_SIGNUP_ENABLED';

export function authorizedSignupEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('authorized-signup', undefined, env);
}
