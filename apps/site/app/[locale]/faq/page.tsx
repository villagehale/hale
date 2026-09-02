import type { Metadata } from 'next';
import { CopyNumberButton } from '~/components/copy-number';
import { CtaBand } from '~/components/cta-band';
import { LandingCta } from '~/components/landing-cta';
import { ProductFaqAccordion } from '~/components/product-faq-accordion';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { type HeadlineSegment, WordsPullUp } from '~/components/words-pull-up';
import { buildAlternates, ogLocale } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import { type Locale, routing } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { FAQ, type FaqItem, faqJsonLd } from '~/lib/faq/index';
import { chromeCta } from '~/lib/site/chrome-cta';
import { readSmsNumber } from '~/lib/text-entry';

interface PageProps {
  params: Promise<{ locale: Locale }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'Faq');
  const title = t('metaTitle');
  const description = t('metaDescription');
  return {
    title,
    description,
    alternates: buildAlternates(locale, '/faq'),
    openGraph: {
      type: 'website',
      title,
      description,
      url: localeHref(locale, '/faq'),
      siteName: 'Hale',
      locale: ogLocale(locale),
    },
    twitter: { card: 'summary_large_image', title, description },
  };
}

/** English is the canonical FAQ (lib/faq, with its own JSON-LD + tests); other
 * locales read the translated list from messages. */
function faqItems(locale: Locale): readonly FaqItem[] {
  if (locale === routing.defaultLocale) return FAQ;
  return getTranslator(locale, 'Faq').raw('items') as FaqItem[];
}

export default async function FaqPage({ params }: PageProps) {
  const { locale } = await params;
  const t = getTranslator(locale, 'Faq');
  const items = faqItems(locale);
  const cta = chromeCta(locale);
  const copy = getTranslator(locale, 'CopyNumber');
  const number = readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER);

  return (
    <main id="main" tabIndex={-1} className="relative">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input) — the standard way to emit SEO structured data.
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd(items, locale)) }}
      />
      <SiteHeader locale={locale} />

      <section className="shell pt-10 sm:pt-16 pb-16 lg:pb-24">
        <div className="max-w-2xl">
          <span className="eyebrow">{t('eyebrow')}</span>
          <WordsPullUp className="mt-3" segments={t.raw('headline') as HeadlineSegment[]} />
          <p className="meta reading-measure mt-6 text-lg" style={{ lineHeight: 1.6 }}>
            {t('lede')}
          </p>
        </div>

        <div className="mt-14 max-w-3xl">
          <ProductFaqAccordion items={items} />
        </div>
      </section>

      <CtaBand>
        <h2 className="mx-auto max-w-2xl font-display text-2xl">{t('ctaHeading')}</h2>
        <p className="cta-sub mx-auto mt-4 max-w-xl" style={{ lineHeight: 1.6 }}>
          {t('ctaSub')}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <LandingCta
            event="cta_text_click"
            channel="sms"
            placement="faq"
            href={cta.href}
            className="btn-on-navy"
          >
            {cta.label}
          </LandingCta>
          {number ? (
            <CopyNumberButton
              number={number}
              placement="faq"
              className="btn-on-navy-quiet"
              label={copy('label')}
              copiedLabel={copy('copied')}
              ariaLabel={copy('aria')}
            />
          ) : null}
        </div>
      </CtaBand>

      <SiteFooter locale={locale} />
    </main>
  );
}
