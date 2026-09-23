import { PLAN_TIERS_ORDERED, type PlanTier, formatPlanPrice } from '@hale/types';
import { Check } from 'lucide-react';
import { LandingCta } from '~/components/landing-cta';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { chromeCta } from '~/lib/site/chrome-cta';

// Marketing presentation per tier — the panel tint. Prices for the paid tiers
// stay the CAD strings from formatPlanPrice. Names and feature lines are
// localized in PricingSection messages: English is pinned equal to PLAN_DISPLAY
// in pricing-section.test.ts, and fr/zh must not render the English list.
// Free-tier features stay marketing-only (`freeFeatures`), not the portal catalog.
const TIER_PANEL = {
  free: 'glass-panel',
  plus: 'glass-panel numbered-card-marked',
  family: 'glass-panel',
} as const satisfies Record<PlanTier, string>;

/**
 * The landing pricing section. Free leads — the whole core is free; Plus and Family
 * add year-attention as it ships, never a live checkout. Monthly and annual are both
 * shown, with annual as the better value (about three months free). Every tier's CTA
 * is the one front door the site chrome offers — texting Hale — because there is no
 * other way in: these buttons pointed at the app's /onboarding wizard, which F14
 * deleted, so a pricing page's only action 308'd back to the homepage.
 * Names, one-liners, and feature lines come from the locale bundle. English and
 * French `tierLines` are the VIL-367 bytes locked by Sloane and Miles on 2026-09-23.
 * Chinese `tierLines` stay the previous translation. Do not invent a ZH twin here.
 * The free price word is the tier name (`Gratuit`, `免费`), not the English `Free`
 * that formatPlanPrice returns. Free-tier features are marketing-only: SMS, rec
 * dates, answers, founding rate — not the Village/Companion bullets the portal
 * catalog still carries.
 */
export function PricingSection({ locale = routing.defaultLocale }: { locale?: Locale }) {
  const t = getTranslator(locale, 'PricingSection');
  const tierLines: Record<PlanTier, string> = {
    free: t('tierLines.free'),
    plus: t('tierLines.plus'),
    family: t('tierLines.family'),
  };
  const tierNames: Record<PlanTier, string> = {
    free: t('tierNames.free'),
    plus: t('tierNames.plus'),
    family: t('tierNames.family'),
  };
  const freeFeatures = t.raw('freeFeatures') as string[];
  const paidFeatures: Record<Exclude<PlanTier, 'free'>, string[]> = {
    plus: t.raw('paidFeatures.plus') as string[],
    family: t.raw('paidFeatures.family') as string[],
  };
  const cta = chromeCta(locale);
  return (
    <section id="pricing" className="shell pb-20 lg:pb-28">
      <div className="max-w-2xl mb-10 lg:mb-12">
        <span className="eyebrow">{t('eyebrow')}</span>
        {/* The one section headline on the site that was never in the display
            system — it rendered in the base sans while every other section H2
            was serif, and against a single-weight display face that inverted:
            the sans H2 out-weighed the page H1 above it, two bare headlines in
            one column. It stays in the display system now that the face has a
            weight axis, where it clears the plan card's price by 162%. */}
        <h2 className="v4-display mt-3">{t('headline')}</h2>
        <p className="mt-5 text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
          {t('lede')}
        </p>
      </div>

      <div className="panel-apricot-tint px-8 py-6 mb-10 lg:mb-12 flex flex-wrap items-baseline justify-between gap-x-10 gap-y-2">
        <p className="font-display text-xl font-semibold" style={{ color: 'var(--color-spruce)' }}>
          {t('foundingTitle')}
        </p>
        <p className="meta text-slate-green">{t('foundingNote')}</p>
      </div>

      {/* An <ol>, because the three tiers ARE a sequence — each one is the one
       * below it plus more of the work. That is also why the cards carry 01/02/03:
       * the number is the ladder position, not decoration. */}
      <ol className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
        {PLAN_TIERS_ORDERED.map((tier, i) => {
          const isFree = tier === 'free';
          const features = isFree ? freeFeatures : paidFeatures[tier];
          return (
            <li key={tier} className={`${TIER_PANEL[tier]} numbered-card`}>
              <div className="numbered-card-head">
                <span className="eyebrow">{tierNames[tier]}</span>
                <span className="numbered-card-num">0{i + 1}</span>
              </div>
              {/* The price is what a pricing card is titled by — the tier's name is
               * the label above it. The free tier's price word is that same name. */}
              <h3
                className="mt-5"
                style={{ fontSize: 'clamp(1.5rem, 2.6vw, 1.9rem)', lineHeight: 1.1 }}
              >
                {isFree ? tierNames.free : formatPlanPrice(tier, 'monthly')}
              </h3>
              {isFree ? null : (
                <p className="meta mt-2">
                  <span className="tabular">{formatPlanPrice(tier, 'annual')}</span> {t('annualNote')}
                </p>
              )}
              <p className="mt-5" style={{ color: 'var(--color-spruce)', lineHeight: 1.6 }}>
                {tierLines[tier]}
              </p>
              <ul className="numbered-card-list">
                {features.map((feature) => (
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
                {/* One placement for all three cards: which tier a reader tapped is not
                    a different conversion — every card opens the same composer — and
                    three placement names would split one number into three. */}
                <LandingCta
                  event="cta_text_click"
                  channel="sms"
                  placement="pricing_tier"
                  href={cta.href}
                  className={isFree ? 'btn-primary' : 'btn-secondary'}
                >
                  {cta.label}
                </LandingCta>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="meta mt-6">{t('footnote')}</p>
    </section>
  );
}
