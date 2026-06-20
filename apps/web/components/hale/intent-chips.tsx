'use client';

import { type OnboardingIntent, ONBOARDING_INTENTS } from '@hale/types';

/**
 * The "what are you hoping for" chip multi-select, shared by onboarding (Phase A)
 * and the Family page editor. A fieldset of toggle buttons with aria-pressed —
 * checkbox-group semantics without a hidden input — matching the app's existing
 * toggle pattern (ThemeToggle). Selection is optional and may be empty; order
 * follows ONBOARDING_INTENTS. Selected state is token-driven so it tracks
 * light / dark automatically (bg-oat + spruce border, like the plan picker).
 */
export function IntentChips({
  legend,
  selected,
  onToggle,
  disabled,
}: {
  legend: string;
  selected: readonly OnboardingIntent[];
  onToggle: (value: OnboardingIntent) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset>
      <legend className="eyebrow">{legend}</legend>
      <div className="mt-3 flex flex-wrap gap-2">
        {ONBOARDING_INTENTS.map(({ value, label }) => {
          const isSelected = selected.includes(value);
          return (
            <button
              key={value}
              type="button"
              aria-pressed={isSelected}
              disabled={disabled}
              onClick={() => onToggle(value)}
              className={`rounded-full px-4 py-2 text-sm leading-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                isSelected
                  ? 'bg-oat border border-spruce text-spruce'
                  : 'border border-rule-strong text-slate-green hover:border-spruce'
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
