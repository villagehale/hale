import type { PlanTier } from '@hale/types';

/** True when this household already has a live paid plan or a Stripe subscription. */
export function familyAlreadySubscribed(family: {
  planTier: PlanTier | string;
  stripeSubscriptionId: string | null;
}): boolean {
  return (
    family.planTier === 'plus' ||
    family.planTier === 'family' ||
    Boolean(family.stripeSubscriptionId)
  );
}
