/**
 * Plan/billing is family-level (state.md: per-stage plans REJECTED — stages
 * coexist in one family). No tier gates anything today (VIL-131: every family
 * gets everything); the column and the Stripe seam stay for VIL-208.
 */
export type PlanTier = 'free' | 'plus' | 'family';

/** The two billing periods the dormant checkout seam accepts. */
export type BillingPeriod = 'monthly' | 'annual';
