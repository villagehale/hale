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
import { requestBlackFridayOffer, requestHolidayPromo } from '~/lib/promo/server';
import { shareCardImage, shareQueryForRequest } from '~/lib/site/share-cards';
import { pricingJsonLd } from '~/lib/site/structured-data';
import { readSmsNumber } from '~/lib/text-entry';

interface PageProps {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}

/** Request-time promo flag + cutoff; see the homepage note. */
export const dynamic = 'force-dynamic';

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'Pricing');
  const title = t('metaTitle');
  const description = t('metaDescription');
  const image = shareCardImage('pricing', await shareQueryForRequest(locale, await searchParams));
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
    <>
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD is a serialized in-repo data object (no user input).
        dangerouslySetInnerHTML={{ __html: JSON.stringify(pricingJsonLd(locale, { search })) }}
      />
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
        blackFriday={await requestBlackFridayOffer(locale, searchParams)}
        priceSurface={priceSurface}
        currency={currency}
      />
    </>
  );
}
