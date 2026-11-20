/**
 * MAX_ENTITLEMENTS_ENABLED — Max-only search/watch/signup/ops entitlements.
 *
 * Off unless exactly `true`. Unset, `true\n`, `TRUE`, `1`, and `on` stay off.
 * Env-only: nothing in PostHog may turn this on (same contract as holiday
 * promo). Do not turn this on in any environment from this change: off, Max
 * unlocks exactly what Plus does.
 */
import { type FamilyEntitlements, type PlanTier, entitlementsFor } from '@hale/types';

export const MAX_ENTITLEMENTS_ENABLED_ENV = 'MAX_ENTITLEMENTS_ENABLED';

export function maxEntitlementsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[MAX_ENTITLEMENTS_ENABLED_ENV] === 'true';
}

export function entitlementsForFamily(
  tier: PlanTier,
  env: Record<string, string | undefined> = process.env,
): FamilyEntitlements {
  return entitlementsFor(tier, maxEntitlementsEnabled(env));
}
