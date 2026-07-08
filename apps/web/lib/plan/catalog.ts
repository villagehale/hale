import {
  formatPlanPrice,
  PLAN_DISPLAY,
  PLAN_TIERS_ORDERED,
  type PlanTier,
} from '@hale/types';

/**
 * The serializable plan catalog for the native Plan surface — derived ENTIRELY from
 * the @hale/types source of truth (PLAN_DISPLAY + formatPlanPrice), so the app never
 * hardcodes tier names, prices, or feature lists. The mobile bundle can't import
 * package code, so this presents the same data over the API instead of the app
 * mirroring it (which would silently drift). Presentation only — it gates nothing.
 */

export interface PlanTierView {
  tier: PlanTier;
  name: string;
  tagline: string;
  /** Pre-formatted CAD strings so the client renders them without re-deriving. */
  monthlyPrice: string;
  annualPrice: string;
  features: string[];
  /** True for the fully-functional default tier (monthly + annual both 0). */
  isFree: boolean;
}

export interface PlanCatalogView {
  /** The family's current tier (families.planTier). */
  currentTier: PlanTier;
  /** Every tier, free-first (PLAN_TIERS_ORDERED). */
  tiers: PlanTierView[];
}

/** Builds the catalog view from the plan-display source of truth. Pure — no I/O. */
export function buildPlanCatalog(currentTier: PlanTier): PlanCatalogView {
  return {
    currentTier,
    tiers: PLAN_TIERS_ORDERED.map((tier) => {
      const display = PLAN_DISPLAY[tier];
      return {
        tier,
        name: display.name,
        tagline: display.tagline,
        monthlyPrice: formatPlanPrice(tier, 'monthly'),
        annualPrice: formatPlanPrice(tier, 'annual'),
        features: [...display.features],
        isFree: display.monthlyPriceCad === 0 && display.annualPriceCad === 0,
      };
    }),
  };
}
