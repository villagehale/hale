'use client';

import {
  type BillingPeriod,
  PLAN_DISPLAY,
  PLAN_TIERS_ORDERED,
  type PlanTier,
  formatPlanPrice,
} from '@hale/types';
import { useState } from 'react';
import { BillingToggle } from './billing-toggle';

/**
 * The onboarding plan picker — the LAST choice before provisioning. A standalone,
 * self-contained radio group rendering the three tiers from the shared display
 * source (@hale/types · PLAN_DISPLAY), with a monthly↔annual toggle. Free leads
 * and is the default. It reports the selection up so the wizard can capture it on
 * finish — no server action, no audit, no charge. Finishing never requires payment:
 * a paid pick simply records intent; billing comes later.
 */

export function OnboardingPlanPicker({
  selected,
  onSelect,
}: {
  selected: PlanTier;
  onSelect: (tier: PlanTier) => void;
}) {
  const [period, setPeriod] = useState<BillingPeriod>('monthly');

  return (
    <fieldset>
      <legend className="eyebrow text-spruce">choose a plan</legend>
      <p className="meta mt-2">
        the village is free, always. start there — nothing is charged today.
      </p>
      <div className="mt-4">
        <BillingToggle period={period} onChange={setPeriod} />
      </div>
      <div className="mt-4 space-y-3">
        {PLAN_TIERS_ORDERED.map((tier) => {
          const plan = PLAN_DISPLAY[tier];
          const isFree = tier === 'free';
          const isSelected = selected === tier;
          return (
            <label
              key={tier}
              className={`choice-card text-left p-4 rounded-[var(--r-md)] transition-colors flex items-baseline justify-between gap-4 ${
                isFree
                  ? `cursor-pointer ${
                      isSelected
                        ? 'bg-oat border border-spruce'
                        : 'border border-rule-strong hover:border-spruce'
                    }`
                  : 'border border-rule-strong opacity-60'
              }`}
            >
              <span>
                <span className="font-display text-xl block">{plan.name}</span>
                <span className="meta block mt-1">{plan.tagline}</span>
              </span>
              <span className="flex flex-col items-end shrink-0">
                <span className="font-mono text-base font-semibold text-spruce">
                  {formatPlanPrice(tier, period)}
                </span>
                {isFree ? (
                  isSelected ? (
                    <span className="eyebrow text-spruce mt-1">selected</span>
                  ) : null
                ) : (
                  <span className="eyebrow text-slate-green mt-1">coming soon</span>
                )}
              </span>
              <input
                type="radio"
                name="onboarding-plan-tier"
                value={tier}
                checked={isSelected}
                disabled={!isFree}
                onChange={() => onSelect(tier)}
                className="sr-only"
              />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
