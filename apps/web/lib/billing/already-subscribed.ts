import type { PlanTier } from '@hale/types';

/**
 * True when this household currently has a paid plan.
 *
 * `stripeSubscriptionId` is a historical Stripe reference. Cancellation /
 * deletion webhooks downgrade `plan_tier` to free and keep the id, so a leftover
 * id is not proof of a live subscription. Live entitlement is the tier.
 */
export function familyAlreadySubscribed(family: {
  planTier: PlanTier | string;
  stripeSubscriptionId?: string | null;
}): boolean {
  return family.planTier === 'plus' || family.planTier === 'family';
}
