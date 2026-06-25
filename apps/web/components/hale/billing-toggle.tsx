'use client';

import type { BillingPeriod } from '@hale/types';

const OPTIONS: { value: BillingPeriod; label: string }[] = [
  { value: 'monthly', label: 'monthly' },
  { value: 'annual', label: 'annual' },
];

/**
 * A small segmented monthly↔annual control, shared by the settings plan section
 * and the onboarding plan step. Mirrors the theme-toggle's pill-segmented look
 * with two text segments; the "better value" hint stacks below on mobile and
 * sits inline from `sm` up.
 */
export function BillingToggle({
  period,
  onChange,
}: {
  period: BillingPeriod;
  onChange: (period: BillingPeriod) => void;
}) {
  return (
    <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
      <fieldset
        className="inline-flex items-center gap-1 m-0 p-1 border-0 min-w-0 rounded-[var(--r-full)] bg-oat"
        aria-label="billing period"
      >
        {OPTIONS.map((opt) => {
          const isActive = period === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={isActive}
              onClick={() => onChange(opt.value)}
              className={`inline-flex min-h-[44px] items-center px-4 rounded-[var(--r-full)] text-sm font-semibold cursor-pointer touch-manipulation transition-colors ${
                isActive ? 'bg-linen text-spruce' : 'text-faded-sage hover:text-spruce'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </fieldset>
      <span className="meta">annual saves about two months</span>
    </div>
  );
}
