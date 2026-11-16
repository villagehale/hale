/**
 * MAX_ENTITLEMENTS_ENABLED — Max-only search/watch/signup/ops entitlements.
 *
 * Off unless exactly `true`. Unset, `true\n`, `TRUE`, `1`, and `on` stay off,
 * same parser as the other launch flags (`exact-true`). Do not turn this on
 * in any environment from this change: off, Max unlocks exactly what Plus does.
 */
import { isEnabled } from '@hale/flags';
import { type FamilyEntitlements, type PlanTier, entitlementsFor } from '@hale/types';

export const MAX_ENTITLEMENTS_ENABLED_ENV = 'MAX_ENTITLEMENTS_ENABLED';

export function maxEntitlementsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isEnabled('max-entitlements', undefined, env);
}

export function entitlementsForFamily(
  tier: PlanTier,
  env: Record<string, string | undefined> = process.env,
): FamilyEntitlements {
  return entitlementsFor(tier, maxEntitlementsEnabled(env));
}
