'use client';

import type { PlanTier } from '@hale/types';

/**
 * The onboarding plan picker — the LAST choice before provisioning. A standalone,
 * self-contained radio group reusing the PlanTier type and the choice-card / focus
 * pattern (DESIGN.md §5). Distinct from the settings family-plan editor (owned
 * elsewhere): no server action, no audit — it just reports the selection up so the
 * wizard can capture it on finish. Nothing is charged today.
 */

const PLAN_OPTIONS: { tier: PlanTier; label: string; note: string }[] = [
  { tier: 'free', label: 'free', note: 'observe + draft · no autonomous action' },
  { tier: 'plus', label: 'plus', note: 'hale acts on your approval · $24/mo' },
  { tier: 'family', label: 'family', note: 'autonomy + commerce + portals · $49/mo' },
];

export function OnboardingPlanPicker({
  selected,
  onSelect,
}: {
  selected: PlanTier;
  onSelect: (tier: PlanTier) => void;
}) {
  return (
    <fieldset>
      <legend className="eyebrow text-spruce">choose a plan</legend>
      <p className="meta mt-2">change it any time — nothing is charged today.</p>
      <div className="mt-4 space-y-3">
        {PLAN_OPTIONS.map((opt) => {
          const isSelected = selected === opt.tier;
          return (
            <label
              key={opt.tier}
              className={`choice-card cursor-pointer text-left p-4 rounded-[var(--r-md)] transition-colors flex items-baseline justify-between ${
                isSelected
                  ? 'bg-oat border border-spruce'
                  : 'border border-rule-strong hover:border-spruce'
              }`}
            >
              <span>
                <span className="font-display text-xl block">{opt.label}</span>
                <span className="meta block mt-1">{opt.note}</span>
              </span>
              <input
                type="radio"
                name="onboarding-plan-tier"
                value={opt.tier}
                checked={isSelected}
                onChange={() => onSelect(opt.tier)}
                className="sr-only"
              />
              {isSelected ? <span className="eyebrow text-spruce">selected</span> : null}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
