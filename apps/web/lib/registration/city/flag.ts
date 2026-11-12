/**
 * VIL-684 — the own-city registration lane: per-city lookups, the coach's view of the
 * family's own city's opening, and the daytime tell queued for the proactive decider.
 *
 * On only when OWN_CITY_REGISTRATION_ENABLED is exactly `true`. A trailing newline from
 * `vercel env add` stays off. Unset stays off. There is no allowlist.
 */
import { isEnabled } from '@hale/flags';

export const OWN_CITY_REGISTRATION_ENABLED_ENV = 'OWN_CITY_REGISTRATION_ENABLED';

export function ownCityRegistrationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('own-city-registration', undefined, env);
}
