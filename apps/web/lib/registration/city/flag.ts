/**
 * VIL-684 — the own-city registration lane: per-city lookups, the coach's view of the
 * family's own city's opening, and the daytime tell queued for the proactive decider.
 *
 * A kill switch: on unless OWN_CITY_REGISTRATION_ENABLED is `false` (trimmed, so a
 * trailing newline from `vercel env add` still turns it off). Unset is on. There is no
 * allowlist. Off stops the lookups, the queueing, the review of tells already queued or
 * held, and the coach's own-city context.
 */
import { isEnabled } from '@hale/flags';

export const OWN_CITY_REGISTRATION_ENABLED_ENV = 'OWN_CITY_REGISTRATION_ENABLED';

export function ownCityRegistrationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('own-city-registration', undefined, env);
}
