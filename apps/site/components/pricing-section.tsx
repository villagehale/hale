import { PLAN_DISPLAY, PLAN_TIERS_ORDERED, type PlanTier, formatPlanPrice } from '@hale/types';
import { Check } from 'lucide-react';
import { chromeCta } from '~/lib/site/chrome-cta';

// Marketing presentation per tier — the panel tint and the one-line "do more"
// framing. The NAMES, PRICES, and FEATURES come from the shared source of truth
// (@hale/types · PLAN_DISPLAY) so they never drift from the app.
const TIER_PRESENTATION = {
  free: {
    panel: 'glass-panel',
    line: 'Join the village, see what families near you recommend, and share what you love. The whole core — every stage, every child — free, always.',
  },
  plus: {
    panel: 'glass-panel numbered-card-marked',
    line: 'For when you want Hale to do more: once it has earned your trust, it acts on your approval — reminders, drafts, and your calendar, every child, as integrations roll out.',
  },
  family: {
    panel: 'glass-panel',
    line: 'For when you want Hale to handle it: full autonomy on your approval, commerce and booking as they roll out, concierge and priority support.',
  },
} as const satisfies Record<PlanTier, { panel: string; line: string }>;

/**
 * The landing pricing section. Free leads — the village is free; Plus and Family
 * are framed as "for when you want Hale to do more." Monthly and annual are both
 * shown, with annual as the better value (about two months free). Every tier's CTA
 * is the one front door the site chrome offers — texting Hale — because there is no
 * other way in: these buttons pointed at the app's /onboarding wizard, which F14
 * deleted, so a pricing page's only action 308'd back to the homepage.
 * Names/prices/features render from @hale/types so they never drift.
 */
export function PricingSection() {
  const cta = chromeCta();
  return (
    <section id="pricing" className="shell pb-20 lg:pb-28">
      <div className="max-w-2xl mb-10 lg:mb-12">
        <span className="eyebrow">Three sizes of help</span>
        <h2 className="mt-3">The village is free. Pay only when you want Hale to do more.</h2>
        <p className="mt-5 text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
          Joining the village, seeing what families near you recommend, asking Hale, sharing what
          you love — free, always, every stage and every child. The paid tiers are for when you want
          Hale to do more of the work itself. Each is a little less monthly when you pay yearly —
          about two months free.
        </p>
      </div>

      <div className="panel-apricot-tint px-8 py-6 mb-10 lg:mb-12 flex flex-wrap items-baseline justify-between gap-x-10 gap-y-2">
        <p className="font-display text-xl font-semibold" style={{ color: 'var(--color-spruce)' }}>
          Founding families join free.
        </p>
        <p className="meta text-slate-green">
          The first 100 families get a permanent founding badge — and first access when Plus and
          Family open.
        </p>
      </div>

      {/* An <ol>, because the three tiers ARE a sequence — each one is the one
       * below it plus more of the work. That is also why the cards carry 01/02/03:
       * the number is the ladder position, not decoration. */}
      <ol className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
        {PLAN_TIERS_ORDERED.map((tier, i) => {
          const plan = PLAN_DISPLAY[tier];
          const presentation = TIER_PRESENTATION[tier];
          const isFree = tier === 'free';
          return (
            <li key={tier} className={`${presentation.panel} numbered-card`}>
              <div className="numbered-card-head">
                <span className="eyebrow">{plan.name}</span>
                <span className="numbered-card-num">0{i + 1}</span>
              </div>
              {/* The price is what a pricing card is titled by — the tier's name is
               * the label above it. */}
              <h3
                className="mt-5"
                style={{ fontSize: 'clamp(1.5rem, 2.6vw, 1.9rem)', lineHeight: 1.1 }}
              >
                {formatPlanPrice(tier, 'monthly')}
              </h3>
              {isFree ? null : (
                <p className="meta mt-2">
                  <span className="tabular">{formatPlanPrice(tier, 'annual')}</span> billed yearly —
                  about two months free
                </p>
              )}
              <p className="mt-5" style={{ color: 'var(--color-spruce)', lineHeight: 1.6 }}>
                {presentation.line}
              </p>
              <ul className="numbered-card-list">
                {plan.features.map((feature) => (
                  <li key={feature}>
                    <Check size={16} strokeWidth={2.5} aria-hidden="true" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              {/* Every tier opens the same door — you start by texting Hale — so the
               * free and paid cards differ only in emphasis, not destination.
               * `mt-auto` drops the three actions onto one line across the grid. */}
              <div className="mt-auto pt-8">
                <a href={cta.href} className={isFree ? 'btn-primary' : 'btn-secondary'}>
                  {cta.label}
                </a>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="meta mt-6">
        The village is free to start. Plus and Family open as their integrations ship.
      </p>
    </section>
  );
}
