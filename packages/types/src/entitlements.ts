/**
 * Plan/billing is family-level (state.md: per-stage plans REJECTED — stages
 * coexist in one family). No tier gates anything today (VIL-131: every family
 * gets everything); the column and the Stripe seam stay for VIL-208.
 *
 * `family` is the Max plan in Stripe/UI. A Max purchase writes `family`.
 * Hale-web plan cards do not promise Max-only features, and nothing in the
 * worker is gated on `family` vs `plus`. Site Max copy (highest search/watch
 * limits, priority support, season sign-ups) is marketing until product
 * decides those gates.
 */
export type PlanTier = 'free' | 'plus' | 'family';

/** The two billing periods the dormant checkout seam accepts. */
export type BillingPeriod = 'monthly' | 'annual';
