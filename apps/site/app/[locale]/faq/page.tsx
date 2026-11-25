import type { Metadata } from 'next';
import { RedesignFaq } from '~/components/redesign/faq';
import { tx } from '~/components/redesign/tx';
import { absolutePageUrl, buildAlternates, ogLocale } from '~/i18n/metadata';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { paidPlansCostAnswer } from '~/lib/billing/plain-price';
import { visitorCurrency } from '~/lib/billing/visitor-currency';
import { FAQ, faqJsonLd } from '~/lib/faq/index';
import { intakePrefill } from '~/lib/intake-prefill';
import { pageSource } from '~/lib/page-source';
import { shareCardImage, shareQueryForRequest } from '~/lib/site/share-cards';
import { readSmsNumber } from '~/lib/text-entry';

interface PageProps {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<{ s?: string | string[] }>;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'Faq');
  const title = t('metaTitle');
  const description = t('metaDescription');
  const image = shareCardImage('faq', await shareQueryForRequest(locale, await searchParams));
  return {
    title,
    description,
    alternates: buildAlternates(locale, '/faq'),
    openGraph: {
      type: 'website',
      title,
      description,
      url: absolutePageUrl(locale, '/faq'),
      siteName: 'Hale',
      locale: ogLocale(locale),
      images: [image],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

export default async function FaqPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const source = await pageSource(searchParams);
  const currency = await visitorCurrency();
  const items = FAQ.map((item) => ({
    question: tx(locale, item.question),
    answer: tx(
      locale,
      item.id === 'what-do-paid-plans-cost' ? paidPlansCostAnswer(currency) : item.answer,
    ),
  }));
  return (
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input).
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd(items, locale)) }}
      />
      <RedesignFaq
        locale={locale}
        smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)}
        prefill={intakePrefill(locale)}
        source={source}
        currency={currency}
      />
    </>
  );
}
