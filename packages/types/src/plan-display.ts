import type { PlanTier } from './entitlements.js';

/**
 * The DISPLAYED plan model — the single source of truth for tier names, taglines,
 * prices, and feature lists shown to families (settings, onboarding, the marketing
 * site). This is presentation only: it does NOT gate anything. Entitlement
 * ENFORCEMENT lives in entitlements.ts (PLAN_ENTITLEMENTS) and is unchanged here.
 *
 * Pre-PMF the free tier (Free) is fully functional and the active default;
 * paid tiers are surfaced with soft CTAs (billing isn't wired). Prices are CAD
 * (Canada-first) — `formatPlanPrice` renders them with an explicit CAD label.
 * Annual is the better value — `annualPriceCad / 12` works out to roughly two
 * months free versus paying monthly.
 */
export interface PlanDisplay {
  /** Public display name, e.g. "Free". Distinct from the PlanTier enum value. */
  readonly name: string;
  /** One-line promise of what the tier does, sentence case. */
  readonly tagline: string;
  /** Monthly price in CAD. 0 for the free tier. */
  readonly monthlyPriceCad: number;
  /** Annual price in CAD (billed yearly). 0 for the free tier. */
  readonly annualPriceCad: number;
  /** What the tier includes, as plain reader-facing lines. */
  readonly features: readonly string[];
}

/**
 * Tier display metadata keyed by PlanTier. `satisfies Record<PlanTier, ...>` keeps
 * it exhaustive — a new tier without display data is a COMPILE error, mirroring
 * PLAN_ENTITLEMENTS, so no tier can ship un-presented.
 */
export const PLAN_DISPLAY = {
  free: {
    name: 'Free',
    tagline: 'Everything to get started — free for every family.',
    monthlyPriceCad: 0,
    annualPriceCad: 0,
    features: [
      'Your village feed + trusted recommendations from families near you',
      'Ask Hale, anything, any time',
      'Your kid’s good local week, every stage',
      'Share what you love + invite your village',
      'Companion: logs, milestones, gentle guidance',
      'Drafts held for your approval — nothing acts on its own',
    ],
  },
  plus: {
    name: 'Plus',
    tagline: 'More automation and booking, on your approval.',
    monthlyPriceCad: 9,
    annualPriceCad: 79,
    features: [
      'Everything in Free',
      'Hale acts on the things you approve',
      'Reminders + booking, on your approval',
      'Calendar + integrations, rolling out',
    ],
  },
  family: {
    name: 'Family',
    tagline: 'The full experience for your whole household.',
    monthlyPriceCad: 19,
    annualPriceCad: 159,
    features: [
      'Everything in Plus',
      'Full autonomy, earned task by task',
      'Commerce + booking, as integrations roll out',
      'Concierge + priority support',
    ],
  },
} as const satisfies Record<PlanTier, PlanDisplay>;

/** Display order, free-leads. The product presents Free first, always. */
export const PLAN_TIERS_ORDERED = ['free', 'plus', 'family'] as const satisfies readonly PlanTier[];

/** The two billing periods shown side by side; annual is framed as the better value. */
export type BillingPeriod = 'monthly' | 'annual';

/**
 * The price to show for a tier in a given period as a display string, e.g.
 * "$9 CAD/mo" or "$79 CAD/yr" — the CAD label is explicit (Canada-first). The
 * free tier always reads "Free" regardless of period. Pure — no I/O.
 */
export function formatPlanPrice(tier: PlanTier, period: BillingPeriod): string {
  const plan = PLAN_DISPLAY[tier];
  if (plan.monthlyPriceCad === 0 && plan.annualPriceCad === 0) {
    return 'Free';
  }
  return period === 'annual'
    ? `$${plan.annualPriceCad} CAD/yr`
    : `$${plan.monthlyPriceCad} CAD/mo`;
}
