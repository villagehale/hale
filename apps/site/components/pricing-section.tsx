import { PLAN_DISPLAY, PLAN_TIERS_ORDERED, type PlanTier, formatPlanPrice } from '@hale/types';
import { Check } from 'lucide-react';
import { APP_URL } from '~/lib/app-url';

// Marketing presentation per tier — the panel tint and the one-line "do more"
// framing. The NAMES, PRICES, and FEATURES come from the shared source of truth
// (@hale/types · PLAN_DISPLAY) so they never drift from the app.
const TIER_PRESENTATION = {
  free: {
    panel: 'panel-oat',
    line: 'Join the village, see what families near you recommend, and share what you love. The whole core — every stage, every child — free, always.',
  },
  plus: {
    panel: 'panel-apricot-tint',
    line: 'For when you want Hale to do more: once it has earned your trust, it acts on your approval — reminders, drafts, and your calendar, every child, as integrations roll out.',
  },
  family: {
    panel: 'panel-oat',
    line: 'For when you want Hale to handle it: full autonomy on your approval, commerce and booking as they roll out, concierge and priority support.',
  },
} as const satisfies Record<PlanTier, { panel: string; line: string }>;

/**
 * The landing pricing section. Free leads — the village is free; Plus and Family
 * are framed as "for when you want Hale to do more." Monthly and annual are both
 * shown, with annual as the better value (about two months free). Paid CTAs
 * capture the waitlist (billing isn't wired); the only live signup CTA is
 * "Join free." Names/prices/features render from @hale/types so they never drift.
 */
export function PricingSection() {
  return (
    <section id="pricing" className="shell pb-20 lg:pb-28">
      <div className="max-w-2xl mb-10 lg:mb-12">
        <span className="eyebrow">Three sizes of help</span>
        <h2 className="mt-3">The village is free. Pay only when you want Hale to do more.</h2>
        <p className="mt-5 text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
          Joining the village, seeing what families near you recommend, asking Hale, sharing what
          you love — free, always, every stage and every child. The paid tiers are for when you want
          Hale to do more of the work itself. Each is a little less monthly when you pay
          yearly — about two months free.
        </p>
      </div>

      <div className="panel-apricot-tint px-8 py-6 mb-10 lg:mb-12 flex flex-wrap items-baseline justify-between gap-x-10 gap-y-2">
        <p
          className="font-display text-xl font-semibold"
          style={{ color: 'var(--color-spruce)' }}
        >
          Founding families join free.
        </p>
        <p className="meta">
          The first 100 families get a permanent founding badge — and first access when Plus and
          Family open.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
        {PLAN_TIERS_ORDERED.map((tier, i) => {
          const plan = PLAN_DISPLAY[tier];
          const presentation = TIER_PRESENTATION[tier];
          const isFree = tier === 'free';
          return (
            <div
              key={tier}
              className={`${presentation.panel} px-8 py-10 flex flex-col rise rise-${i + 1}`}
            >
              <h3>{plan.name}</h3>
              <p className="mt-2 font-mono text-xl font-semibold accent">
                {formatPlanPrice(tier, 'monthly')}
                {isFree ? null : (
                  <span style={{ color: 'var(--color-slate-green)' }}>
                    {' '}
                    · {formatPlanPrice(tier, 'annual')}
                  </span>
                )}
              </p>
              {isFree ? null : <p className="meta mt-1">billed yearly — about two months free</p>}
              <p className="mt-5" style={{ color: 'var(--color-spruce)', lineHeight: 1.6 }}>
                {presentation.line}
              </p>
              <ul className="mt-6 flex flex-col gap-2.5">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-start gap-2.5">
                    <Check
                      size={16}
                      strokeWidth={2.5}
                      aria-hidden="true"
                      className="shrink-0"
                      style={{ marginTop: 4, color: 'var(--color-sage)' }}
                    />
                    <span style={{ color: 'var(--color-slate-green)', lineHeight: 1.45 }}>
                      {feature}
                    </span>
                  </li>
                ))}
              </ul>
              {isFree ? (
                <a href={`${APP_URL}/sign-up`} className="btn-primary self-start mt-8">
                  Join free
                </a>
              ) : (
                <a href={`${APP_URL}/sign-up`} className="btn-secondary self-start mt-8">
                  Start free — upgrade when it ships
                </a>
              )}
            </div>
          );
        })}
      </div>
      <p className="meta mt-6">
        The village is free to start. Plus and Family open as their integrations ship.
      </p>
    </section>
  );
}
