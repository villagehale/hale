import { ArrowUpRight } from 'lucide-react';
import type { Metadata } from 'next';
import { CtaBand } from '~/components/cta-band';
import { LandingCta } from '~/components/landing-cta';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { type HeadlineSegment, WordsPullUp } from '~/components/words-pull-up';
import { buildAlternates, ogLocale } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { allCities, publishedCities } from '~/lib/activities/index';
import { hubJsonLd } from '~/lib/activities/structured-data';
import { chromeCta } from '~/lib/site/chrome-cta';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'Activities');
  const title = t('metaTitle');
  const description = t('metaDescription');
  return {
    title,
    description,
    alternates: buildAlternates(locale, '/activities'),
    // The hub enters the index only once at least one city guide is reviewed and
    // published (the review-before-index gate); until then it's a live preview.
    robots: publishedCities.length > 0 ? undefined : { index: false, follow: true },
    openGraph: {
      type: 'website',
      title,
      description,
      url: localeHref(locale, '/activities'),
      siteName: 'Hale',
      locale: ogLocale(locale),
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default async function ActivitiesHub({ params }: PageProps) {
  const { locale } = await params;
  const t = getTranslator(locale, 'Activities');
  // The one front door, resolved the same way the header and footer resolve theirs:
  // texting Hale (or the honest email fallback when no number is provisioned).
  const cta = chromeCta(locale);
  return (
    <main id="main" tabIndex={-1} className="relative">
      {publishedCities.length > 0 ? (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
          dangerouslySetInnerHTML={{ __html: JSON.stringify(hubJsonLd(publishedCities)) }}
        />
      ) : null}
      <SiteHeader locale={locale} />

      <section className="shell pt-10 sm:pt-16 pb-12 lg:pb-16">
        <div className="max-w-2xl">
          <span className="eyebrow">{t('eyebrow')}</span>
          <WordsPullUp className="mt-4" segments={t.raw('headline') as HeadlineSegment[]} />
          <p className="meta reading-measure mt-6 text-lg" style={{ lineHeight: 1.6 }}>
            {t('lede')}
          </p>
        </div>
      </section>

      <div className="band-cream grain">
        <section className="shell py-16 lg:py-24">
          <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {allCities.map((city) => (
              <li key={city.slug}>
                <a
                  href={localeHref(locale, `/activities/${city.slug}`)}
                  className="glass-panel lift px-6 py-5 flex items-center justify-between gap-4"
                >
                  <span>
                    <span className="font-display text-lg text-spruce">{city.city}</span>
                    <span className="meta block text-sm">{city.province}</span>
                  </span>
                  <ArrowUpRight
                    className="text-apricot-deep shrink-0"
                    size={20}
                    aria-hidden="true"
                  />
                </a>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <CtaBand>
        <h2 className="mx-auto max-w-2xl font-display text-2xl">{t('ctaHeading')}</h2>
        <p className="cta-sub mx-auto mt-4 max-w-xl" style={{ lineHeight: 1.6 }}>
          {t('ctaSub')}
        </p>
        <div className="mt-8 flex justify-center">
          <LandingCta
            event="cta_text_click"
            placement="activities"
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
