import { isFoundingPromoWindowOpen, parseFoundingPromoEndsAt } from '@hale/types';

/**
 * Marketing-site price copy. Flag off keeps today's free claims. During the
 * founding window, #1285 owns the sale UI — this PR leaves that copy alone.
 * After the exclusive 2027-01-01 00:00 America/Toronto cutoff, with
 * HOLIDAY_PROMO_ENABLED still on, show Plus list prices instead of "all free /
 * Plus coming soon".
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
