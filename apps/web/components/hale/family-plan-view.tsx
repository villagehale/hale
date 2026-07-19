'use client';

import { AlertCircle, Check } from 'lucide-react';
import {
  type BillingPeriod,
  PLAN_DISPLAY,
  PLAN_TIERS_ORDERED,
  type PlanTier,
  formatPlanPrice,
} from '@hale/types';
import { PREVIEW_NOTE, SIGNED_OUT_NOTE } from '~/lib/family/form-copy';
import { BillingToggle } from './billing-toggle';

/** The plan-section render state, owned by the stateful FamilyPlan wrapper. */
export type FamilyPlanState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved' }
  | { kind: 'notified'; tier: PlanTier }
  | { kind: 'redirecting' }
  | { kind: 'checkout_error' }
  | { kind: 'preview' }
  | { kind: 'signed_out' }
  | { kind: 'error' };

/**
 * The presentational plan & billing section: three tiers from the shared display
 * source (@hale/types · PLAN_DISPLAY) with a monthly↔annual toggle. The current
 * tier reads "your plan"; the village (Free) is fully functional, and the paid
 * tiers carry a soft "notify me" CTA because billing isn't wired (no checkout, no
 * charge). Split from the stateful wrapper (which owns the server action) so it
 * renders without the db/auth import — same pattern as account-menu-view.
 */
export function FamilyPlanView({
  current,
  period,
  state,
  billingConfigured,
  onPeriodChange,
  onSelectFree,
  onNotify,
  onUpgrade,
}: {
  current: PlanTier;
  period: BillingPeriod;
  state: FamilyPlanState;
  /** True when Stripe checkout is live; gates the Upgrade CTA vs. the "notify me"
   * placeholder so the button only appears when a real checkout would succeed. */
  billingConfigured: boolean;
  onPeriodChange: (period: BillingPeriod) => void;
  onSelectFree: () => void;
  onNotify: (tier: PlanTier) => void;
  onUpgrade: (tier: PlanTier) => void;
}) {
  return (
    <div className="space-y-6 max-w-2xl">
      <BillingToggle period={period} onChange={onPeriodChange} />

      <ul className="space-y-4">
        {PLAN_TIERS_ORDERED.map((tier) => {
          const plan = PLAN_DISPLAY[tier];
          const isCurrent = current === tier;
          const isFree = tier === 'free';
          return (
            <li
              key={tier}
              className={`p-5 rounded-[var(--r-xl)] border ${
                isCurrent ? 'bg-oat border-spruce' : 'border-rule-strong'
              }`}
            >
              <div className="flex items-baseline justify-between gap-4">
                <div>
                  <h3 className="font-display text-xl leading-tight">{plan.name}</h3>
                  <p className="meta mt-1">{plan.tagline}</p>
                </div>
                <div className="text-right shrink-0">
                  <span className="font-mono text-lg font-semibold text-spruce">
                    {formatPlanPrice(tier, period)}
                  </span>
                  {!isFree && period === 'annual' ? (
                    <span className="meta block">about two months free</span>
                  ) : null}
                </div>
              </div>

              <ul className="mt-4 space-y-2">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2 text-slate-green">
                    <Check
                      size={16}
                      strokeWidth={2}
                      aria-hidden="true"
                      className="shrink-0 mt-1 text-sage"
                    />
                    <span className="leading-snug">{feature}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-5">
                {isCurrent ? (
                  <span className="pill pill-sage">
                    <Check size={14} strokeWidth={2.5} aria-hidden="true" />
                    your plan
                  </span>
                ) : isFree ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={onSelectFree}
                    disabled={state.kind === 'saving'}
                  >
                    switch to {plan.name}
                  </button>
                ) : billingConfigured ? (
                  <button
                    type="button"
                    className="btn-primary"
                    onClick={() => onUpgrade(tier)}
                    disabled={state.kind === 'redirecting'}
                  >
                    upgrade to {plan.name}
                  </button>
                ) : (
                  <button type="button" className="btn-secondary" onClick={() => onNotify(tier)}>
                    notify me when it&rsquo;s ready
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {state.kind === 'saved' ? (
        <output className="meta text-slate-green block">
          you&rsquo;re on the village — nothing charged.
        </output>
      ) : null}
      {state.kind === 'notified' ? (
        <output className="meta text-slate-green block">
          we&rsquo;ll let you know when {PLAN_DISPLAY[state.tier].name} opens — nothing charged today.
        </output>
      ) : null}
      {state.kind === 'redirecting' ? (
        <output className="meta text-slate-green block">taking you to secure checkout&hellip;</output>
      ) : null}
      {state.kind === 'checkout_error' ? (
        <p className="field-error flex items-center gap-2" role="alert">
          <AlertCircle size={14} strokeWidth={2} aria-hidden="true" className="shrink-0" />
          couldn&rsquo;t start checkout just now — please try again.
        </p>
      ) : null}
      {state.kind === 'preview' ? (
        <output className="meta text-slate-green block">{PREVIEW_NOTE}</output>
      ) : null}
      {state.kind === 'signed_out' ? (
        <output className="meta text-slate-green block">{SIGNED_OUT_NOTE}</output>
      ) : null}
      {state.kind === 'error' ? (
        <p className="field-error flex items-center gap-2" role="alert">
          <AlertCircle size={14} strokeWidth={2} aria-hidden="true" className="shrink-0" />
          couldn&rsquo;t change your plan just now — please try again.
        </p>
      ) : null}
    </div>
  );
}
