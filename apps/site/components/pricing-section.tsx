import { Check } from 'lucide-react';
import { LandingCta } from '~/components/landing-cta';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { chromeCta } from '~/lib/site/chrome-cta';

/**
 * Pricing is one fact: Hale is free, with unlimited chat. Paid tiers are not
 * live, so this section does not render a Free/Plus/Family table, a price, or
 * an upgrade. The only action is the same text door as the rest of the site.
 */
export function PricingSection({ locale = routing.defaultLocale }: { locale?: Locale }) {
  const t = getTranslator(locale, 'PricingSection');
  const features = t.raw('freeFeatures') as string[];
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

      <div className="glass-panel max-w-xl">
        <h3 style={{ fontSize: 'clamp(1.5rem, 2.6vw, 1.9rem)', lineHeight: 1.1 }}>{t('freeLine')}</h3>
        <p className="mt-5" style={{ color: 'var(--color-spruce)', lineHeight: 1.6 }}>
          {t('freeBody')}
        </p>
        <ul className="numbered-card-list">
          {features.map((feature) => (
            <li key={feature}>
              <Check size={16} strokeWidth={2.5} aria-hidden="true" />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
        <div className="mt-8">
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
      </div>
      <p className="meta mt-6">{t('footnote')}</p>
    </section>
  );
}
