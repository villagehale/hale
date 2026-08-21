import type { Metadata } from 'next';
import { CtaBand } from '~/components/cta-band';
import { LandingCta } from '~/components/landing-cta';
import { PricingSection } from '~/components/pricing-section';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { type HeadlineSegment, WordsPullUp } from '~/components/words-pull-up';
import { buildAlternates, ogLocale } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { chromeCta } from '~/lib/site/chrome-cta';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'Pricing');
  const title = t('metaTitle');
  const description = t('metaDescription');
  return {
    title,
    description,
    alternates: buildAlternates(locale, '/pricing'),
    openGraph: {
      type: 'website',
      title,
      description,
      url: localeHref(locale, '/pricing'),
      siteName: 'Hale',
      locale: ogLocale(locale),
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function PricingPage({ params }: PageProps) {
  const { locale } = await params;
  const t = getTranslator(locale, 'Pricing');
  // Texting Hale is the one front door: /onboarding was deleted in F14.
  const cta = chromeCta(locale);
  return (
    <main id="main" tabIndex={-1} className="relative">
      <SiteHeader locale={locale} />

      <section className="shell pt-10 sm:pt-16 pb-8 lg:pb-10">
        <div className="max-w-2xl">
          <span className="eyebrow">{t('eyebrow')}</span>
          <WordsPullUp className="mt-4" segments={t.raw('headline') as HeadlineSegment[]} />
          <p className="meta reading-measure mt-6 text-lg" style={{ lineHeight: 1.6 }}>
            {t('lede')}
          </p>
        </div>
      </section>

      <PricingSection locale={locale} />

      <CtaBand>
        <p
          className="mx-auto max-w-2xl font-display"
          style={{
            fontSize: 'clamp(1.4rem, 2.6vw, 2rem)',
            lineHeight: 1.3,
            letterSpacing: 'var(--tracking-display)',
            fontWeight: 600,
          }}
        >
          {t('cta')}
        </p>
        <div className="mt-8 flex justify-center">
          <LandingCta
            event="cta_text_click"
            placement="pricing_band"
            href={cta.href}
            className="btn-on-navy"
          >
            {cta.label}
          </LandingCta>
        </div>
      </CtaBand>

      <SiteFooter locale={locale} />
    </main>
  );
}
