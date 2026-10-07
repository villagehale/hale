import type { Metadata } from 'next';
import { RedesignPricing } from '~/components/redesign/pricing';
import { buildAlternates, ogLocale } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { intakePrefill } from '~/lib/intake-prefill';
import { readSmsNumber } from '~/lib/text-entry';

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
  return (
    <RedesignPricing
      locale={locale}
      smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)}
      prefill={intakePrefill(locale)}
    />
  );
}
