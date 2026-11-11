/**
 * T8 — Browser Use Cloud engine for authorized signup.
 *
 * Off unless BROWSER_USE_SIGNUP_ENABLED is exactly `true`. `true\n`, `TRUE`, `1`
 * and `on` stay off, for the same reason as SIGNUP_SANDBOX_RUNTIME_ENABLED: a
 * piped `echo` into `vercel env add` leaves a trailing newline that would start
 * paid runs nobody armed.
 *
 * This flag does not turn authorized signup on. `AUTHORIZED_SIGNUP_ENABLED`
 * stays a separate exact-`on` gate, and the engine runs only inside
 * `runAuthorizedSignup`, after the parent's explicit yes.
 */
import { isEnabled } from '@hale/flags';

export const BROWSER_USE_SIGNUP_ENABLED_ENV = 'BROWSER_USE_SIGNUP_ENABLED';

export function browserUseSignupEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('browser-use-signup', undefined, env);
}

export const BROWSER_USE_SIGNUP_PAYMENT_ENABLED_ENV = 'BROWSER_USE_SIGNUP_PAYMENT_ENABLED';

/**
 * Agent payment through the Stripe Link wallet. Off unless exactly `true`.
 *
 * ENV-ONLY. Not a PostHog flag. Nothing in PostHog can turn a payment on.
 * Runtime still stops before any payment > $0 (`payment_boundary`) and still
 * caps a signup run at $3 (`SIGNUP_RUN_MAX_COST_USD`).
 */
export function browserUseSignupPaymentEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[BROWSER_USE_SIGNUP_PAYMENT_ENABLED_ENV] === 'true';
}
