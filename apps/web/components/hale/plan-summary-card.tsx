import { formatPlanPrice, PLAN_DISPLAY, type PlanTier } from '@hale/types';

/**
 * The navy "your plan" card at the top of Settings → Plan & billing (design handoff
 * §4.7). Shows the family's ACTUAL tier + price from the shared display source — no
 * fabricated card number or renewal date (the prototype's "Visa ···· 4242 · Renews
 * June 12" is sample data with no backing store, so it never ships — rule #1). The
 * full tier-change / cancel seam renders below in FamilyPlan.
 *
 * Brand-anchored fill: --color-brand + --color-on-spruce is navy-on-white in light
 * and inverts to cream-on-ink in dark (the same pair the primary button uses),
 * verified high-contrast both ways.
 */
export function PlanSummaryCard({ planTier }: { planTier: PlanTier }) {
  const plan = PLAN_DISPLAY[planTier];
  return (
    <div className="plan-navy-card">
      <p className="plan-navy-eyebrow">Your plan</p>
      <div className="plan-navy-headline">
        <span className="plan-navy-name font-display">{plan.name}</span>
        <span className="plan-navy-price">{formatPlanPrice(planTier, 'monthly')}</span>
      </div>
      <p className="plan-navy-tagline">{plan.tagline}</p>
    </div>
  );
}
