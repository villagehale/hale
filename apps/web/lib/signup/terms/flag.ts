import { isEnabled, parseAllowlist } from '@hale/flags';
import { registrationPlanRunEnabled } from '../plan/flag';

/**
 * VIL-715 · pre-flight and approval binding, for this family. Off unless
 * REGISTRATION_PREFLIGHT_ENABLED is exactly `true`, the family is on
 * REGISTRATION_PREFLIGHT_FAMILIES when that list is set, and the plan lane it sits on is
 * on too. It decides whether NEW asks take this lane. A plan already bound keeps its cart
 * checks whatever this says: the run reads the stored approval.
 */
export function registrationPreflightEnabled(
  familyId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('registration-preflight', familyId, env) && registrationPlanRunEnabled(env);
}

export const REGISTRATION_FREE_CHECKOUT_ENABLED_ENV = 'REGISTRATION_FREE_CHECKOUT_ENABLED';
export const REGISTRATION_FREE_CHECKOUT_FAMILIES_ENV = 'REGISTRATION_FREE_CHECKOUT_FAMILIES';

/**
 * Pressing "complete" on a $0 order bound as free. ENV-ONLY, never in PostHog: on only for
 * exact `true` and a family on the list, and an empty list is off. It arms no paid
 * checkout, which stays behind BROWSER_USE_SIGNUP_PAYMENT_ENABLED alone.
 */
export function registrationFreeCheckoutEnabled(
  familyId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    env[REGISTRATION_FREE_CHECKOUT_ENABLED_ENV] === 'true' &&
    parseAllowlist(env, REGISTRATION_FREE_CHECKOUT_FAMILIES_ENV).has(familyId)
  );
}
