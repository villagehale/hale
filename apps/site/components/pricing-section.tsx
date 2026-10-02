import { LandingCta } from '~/components/landing-cta';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { chromeCta } from '~/lib/site/chrome-cta';

const TIERS = ['free', 'plus', 'family'] as const;

/**
 * Three compact cards of the same weight. Free is the live tier and the only
 * text door. Plus and Family are the name and "Coming soon". No price, no
 * founding rate, and no upgrade button on a tier that is not available.
 */
export function PricingSection({ locale = routing.defaultLocale }: { locale?: Locale }) {
  const t = getTranslator(locale, 'PricingSection');
  const features = t.raw('freeFeatures') as string[];
  const names = t.raw('tierNames') as Record<(typeof TIERS)[number], string>;
  const cta = chromeCta(locale);
  return (
    <section id="pricing" className="shell v4-pricing">
      <div className="max-w-2xl mb-6">
        <span className="eyebrow">{t('eyebrow')}</span>
        <h2 className="v4-display mt-3">{t('headline')}</h2>
        <p className="mt-4 text-lg" style={{ color: 'var(--color-slate-green)', lineHeight: 1.6 }}>
          {t('lede')}
        </p>
      </div>

      <ol className="v4-tiers">
        {TIERS.map((tier) => {
          const isFree = tier === 'free';
          return (
            <li key={tier} className="v4-tier">
              <h3 className="v4-tier-name">{names[tier]}</h3>
              {isFree ? (
                <>
                  <p className="v4-tier-status">{features.join(' · ')}</p>
                  <div className="v4-tier-act">
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
                </>
              ) : (
                <p className="v4-tier-status">{t('comingSoon')}</p>
              )}
            </li>
          );
        })}
      </ol>
      <p className="meta mt-4">{t('footnote')}</p>
    </section>
  );
}
