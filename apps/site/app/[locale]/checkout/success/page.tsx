import type { Metadata } from 'next';
import { GooglePurchaseConversion } from '~/components/google-purchase-conversion';
import { MetaPurchaseConversion } from '~/components/meta-purchase-conversion';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { APP_URL } from '~/lib/app-url';
import {
  checkoutSessionIdFromSearch,
  conversionsApiEnabled,
  fetchCheckoutSessionFacts,
  googleAdsConversionSendTo,
  googlePurchaseFromPaidSession,
  metaPixelIdFromEnv,
  metaPurchaseFromPaidSession,
} from '~/lib/billing/checkout-success';

interface PageProps {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<{
    session_id?: string | string[];
    value?: string | string[];
    currency?: string | string[];
  }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'CheckoutSuccess');
  return {
    title: t('metaTitle'),
    robots: { index: false, follow: false },
    alternates: { canonical: localeHref(locale, '/checkout/success') },
  };
}

export default async function CheckoutSuccessPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const t = getTranslator(locale, 'CheckoutSuccess');
  const search = (await searchParams) ?? {};
  const sessionId = checkoutSessionIdFromSearch(search);
  const facts = sessionId ? await fetchCheckoutSessionFacts(sessionId) : null;
  const conversionsEnabled = conversionsApiEnabled();
  const googlePurchase = facts
    ? googlePurchaseFromPaidSession({
        facts,
        conversionsEnabled,
        sendTo: googleAdsConversionSendTo(),
      })
    : null;
  const metaPurchase = facts
    ? metaPurchaseFromPaidSession({
        facts,
        conversionsEnabled,
        pixelId: metaPixelIdFromEnv(),
      })
    : null;

  return (
    <>
      <SiteHeader locale={locale} />
      <div className="rd">
        <main id="main" className="sp-hero">
          <h1 className="sp-h1">{t('heading')}</h1>
          <p className="sp-lede">
            <a href={`${APP_URL}/settings#billing`}>{t('continue')}</a>
          </p>
        </main>
      </div>
      <SiteFooter locale={locale} />
      {googlePurchase ? <GooglePurchaseConversion {...googlePurchase} /> : null}
      {metaPurchase ? <MetaPurchaseConversion {...metaPurchase} /> : null}
    </>
  );
}
