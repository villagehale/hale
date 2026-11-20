import { isFoundingPromoWindowOpen, parseFoundingPromoEndsAt } from '@hale/types';

/**
 * Marketing-site price copy. Flag off is the legacy surface (Plus and Max
 * stay "coming soon"). During the founding window, the holiday promo owns the
 * sale UI. After the exclusive 2027-01-01 00:00 America/Toronto cutoff, with
 * HOLIDAY_PROMO_ENABLED still on, Plus is offered at the list price.
 */
export type SitePriceSurface = 'legacy' | 'list';

export function sitePriceSurface(
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): SitePriceSurface {
  if (env.HOLIDAY_PROMO_ENABLED !== 'true') return 'legacy';
  const ends = parseFoundingPromoEndsAt(env.PROMO_FOUNDING_ENDS_AT);
  return isFoundingPromoWindowOpen(now, ends) ? 'legacy' : 'list';
}
