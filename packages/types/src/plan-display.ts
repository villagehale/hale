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
 * Annual is the better value: at these prices it saves about THREE months versus
 * paying monthly (Plus $228 → $159; Max $468 → $329). Every surface that states
 * the discount says "about three months free" — and apps/site's
 * pricing-section.test.ts derives the claim from these numbers, so a reprice
 * that makes the sentence untrue fails there before it ships.
 * The `family` enum key is displayed as "Max". The key itself does not change.
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
    tagline: 'Free for every family.',
    monthlyPriceCad: 0,
    annualPriceCad: 0,
    features: [
      'Unlimited chat',
      'Live find',
      'A text when a spot opens',
      'Group chats and your co-parent',
    ],
  },
  plus: {
    name: 'Plus',
    tagline: 'Nudges when a weekend’s empty or a waitlist opens, plus year memory as it ships.',
    monthlyPriceCad: 19,
    annualPriceCad: 159,
    features: [
      'Everything in Free',
      'A nudge when a weekend’s empty',
      'Year memory, season to season',
      'Sign-ups done for you, when you say yes',
    ],
  },
  family: {
    name: 'Max',
    tagline: 'Everything in Plus, for every kid and everyone who helps.',
    monthlyPriceCad: 39,
    annualPriceCad: 329,
    features: [
      'Everything in Plus',
      'Every kid, caregivers included',
      'Priority support',
      'Sign-ups for every kid in one go',
    ],
  },
} as const satisfies Record<PlanTier, PlanDisplay>;

/** Display order, free-leads. The product presents Free first, always. */
export const PLAN_TIERS_ORDERED = ['free', 'plus', 'family'] as const satisfies readonly PlanTier[];

/** The two billing periods shown side by side; annual is framed as the better value. */
export type BillingPeriod = 'monthly' | 'annual';

/**
 * The price to show for a tier in a given period as a display string, e.g.
 * "$19 CAD/mo" or "$159 CAD/yr" — the CAD label is explicit (Canada-first). The
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
