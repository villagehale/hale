import { Check } from 'lucide-react';
import { LandingCta } from '~/components/landing-cta';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { chromeCta } from '~/lib/site/chrome-cta';

const TIERS = ['free', 'plus', 'family'] as const;
type PaidTier = 'plus' | 'family';

/**
 * Three cards. Only Free is live: unlimited chat, free today, and the same
 * text door as the rest of the site. Plus and Family are labelled coming soon.
 * Their only line is that more may come later. No price, no date, no
 * buy or waitlist control, and no link on a tier that is not available.
 */
export function PricingSection({ locale = routing.defaultLocale }: { locale?: Locale }) {
  const t = getTranslator(locale, 'PricingSection');
  const freeFeatures = t.raw('freeFeatures') as string[];
  const paidFeatures = t.raw('paidFeatures') as Record<PaidTier, string[]>;
  const names = t.raw('tierNames') as Record<(typeof TIERS)[number], string>;
  const cta = chromeCta(locale);
  return (
    <section id="pricing" className="shell pb-20 lg:pb-28">
      <div className="max-w-2xl mb-10 lg:mb-12">
        <span className="eyebrow">{t('eyebrow')}</span>
        <h2 className="v4-display mt-3">{t('headline')}</h2>
        <p className="mt-5 text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
          {t('lede')}
        </p>
      </div>

      <ol className="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8">
        {TIERS.map((tier, i) => {
          const isFree = tier === 'free';
          const features = isFree ? freeFeatures : paidFeatures[tier];
          return (
            <li key={tier} className="glass-panel numbered-card">
              <div className="numbered-card-head">
                <span className="eyebrow">{names[tier]}</span>
                <span className="numbered-card-num">0{i + 1}</span>
              </div>
              <h3
                className="mt-5"
                style={{ fontSize: 'clamp(1.5rem, 2.6vw, 1.9rem)', lineHeight: 1.1 }}
              >
                {isFree ? t('freeLine') : t('comingSoon')}
              </h3>
              <p className="mt-5" style={{ color: 'var(--color-spruce)', lineHeight: 1.6 }}>
                {isFree ? t('freeBody') : t('comingBody')}
              </p>
              <ul className="numbered-card-list">
                {features.map((feature) => (
                  <li key={feature}>
                    <Check size={16} strokeWidth={2.5} aria-hidden="true" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>
              {isFree ? (
                <div className="mt-auto pt-8">
                  <LandingCta
                    event="cta_text_click"
                    channel="sms"
                    placement="pricing_tier"
                    href={cta.href}
                    className="btn-primary"
                  >
                    {cta.label}
                  </LandingCta>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      <p className="meta mt-6">{t('footnote')}</p>
    </section>
  );
}
