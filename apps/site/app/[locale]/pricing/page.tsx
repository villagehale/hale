import type { Metadata } from 'next';
import { RedesignPricing } from '~/components/redesign/pricing';
import { absolutePageUrl, buildAlternates, ogLocale } from '~/i18n/metadata';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { checkoutWasCancelled } from '~/lib/billing/checkout-success';
import { sitePriceSurface } from '~/lib/billing/site-price-surface';
import { visitorCheckoutCurrency } from '~/lib/billing/visitor-currency';
import { intakePrefill } from '~/lib/intake-prefill';
import { pageSource } from '~/lib/page-source';
import { requestHolidayPromo } from '~/lib/promo/server';
import { shareCardImage } from '~/lib/site/share-cards';
import { readSmsNumber } from '~/lib/text-entry';

interface PageProps {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/** Request-time promo flag + cutoff; see the homepage note. */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'Pricing');
  const title = t('metaTitle');
  const description = t('metaDescription');
  const image = shareCardImage('pricing');
  return {
    title,
    description,
    alternates: buildAlternates(locale, '/pricing'),
    openGraph: {
      type: 'website',
      title,
      description,
      url: absolutePageUrl(locale, '/pricing'),
      siteName: 'Hale',
      locale: ogLocale(locale),
      images: [image],
    },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

export default async function PricingPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const priceSurface = sitePriceSurface();
  const checkoutCurrency = await visitorCheckoutCurrency();
  const currency = checkoutCurrency ?? 'CAD';
  const search = (await searchParams) ?? {};
  return (
    <RedesignPricing
      regionBlocked={checkoutCurrency === null}
      noChargeLine={
        checkoutWasCancelled(search) ? getTranslator(locale, 'Pricing')('noCharge') : null
      }
      locale={locale}
      smsNumber={readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER)}
      prefill={intakePrefill(locale)}
      source={await pageSource(searchParams)}
      promo={await requestHolidayPromo(locale, searchParams)}
      priceSurface={priceSurface}
      currency={currency}
    />
  );
}
