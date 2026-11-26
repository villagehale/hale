import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { CheckoutState } from '~/components/checkout/checkout-state';
import { PricingCheckoutVerify } from '~/components/checkout/pricing-verify';
import { GooglePurchaseConversion } from '~/components/google-purchase-conversion';
import { MetaPurchaseConversion } from '~/components/meta-purchase-conversion';
import { SiteFooter } from '~/components/site-footer';
import { SiteHeader } from '~/components/site-header';
import { absolutePageUrl } from '~/i18n/metadata';
import { localeHref } from '~/i18n/navigation';
import type { Locale } from '~/i18n/routing';
import { getTranslator } from '~/i18n/server';
import { APP_URL } from '~/lib/app-url';
import {
  type CheckoutSuccessView,
  checkoutSessionIdFromSearch,
  checkoutViewForPage,
  conversionsApiEnabled,
  fetchCheckoutSessionFacts,
  googleAdsConversionSendTo,
  googlePurchaseFromPaidSession,
  metaPixelIdsFromEnv,
  metaPurchaseFromPaidSession,
  paidPlanName,
} from '~/lib/billing/checkout-success';
import { openPricingCheckout } from '~/lib/billing/pricing-checkout-open';
import { type Platform, platformFromUa } from '~/lib/chooser';
import { intakePrefill } from '~/lib/intake-prefill';
import { shareCardImage, shareQueryForRequest } from '~/lib/site/share-cards';
import { buildSmsHref, readSmsNumber } from '~/lib/text-entry';

interface PageProps {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<{
    session_id?: string | string[];
    value?: string | string[];
    currency?: string | string[];
  }>;
}

const CONFIRMED_PURCHASE_STATES: ReadonlySet<CheckoutSuccessView['state']> = new Set([
  'plan_active',
  'upgraded',
  'new_visitor',
]);

async function requestPlatform(): Promise<Platform> {
  try {
    return platformFromUa((await headers()).get('user-agent'));
  } catch {
    // Unit renders have no request. Same as a missing header.
    return 'unknown';
  }
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const t = getTranslator(locale, 'CheckoutSuccess');
  const search = (await searchParams) ?? {};
  const sessionId = checkoutSessionIdFromSearch(search);
  const facts = sessionId ? await fetchCheckoutSessionFacts(sessionId) : null;
  const view = checkoutViewForPage(sessionId, facts);
  const purchased = view ? CONFIRMED_PURCHASE_STATES.has(view.state) : facts?.paid === true;
  const title = purchased ? t('metaTitle') : t('unpaidTitle');
  const image = shareCardImage('checkout', await shareQueryForRequest(locale, search, purchased));
  return {
    title,
    robots: { index: false, follow: false },
    alternates: { canonical: localeHref(locale, '/checkout/success') },
    openGraph: {
      title,
      url: absolutePageUrl(locale, '/checkout/success'),
      images: [image],
    },
    twitter: { card: 'summary_large_image', title, images: [image] },
  };
}

export default async function CheckoutSuccessPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const t = getTranslator(locale, 'CheckoutSuccess');
  const search = (await searchParams) ?? {};
  const sessionId = checkoutSessionIdFromSearch(search);
  const facts = sessionId ? await fetchCheckoutSessionFacts(sessionId) : null;
  const paid = facts?.paid === true;
  const planName = paidPlanName(facts);
  const conversionsEnabled = conversionsApiEnabled();
  const googlePurchase = facts
    ? googlePurchaseFromPaidSession({
        facts,
        conversionsEnabled,
        sendTo: googleAdsConversionSendTo(),
      })
    : null;
  const metaPixelIds = metaPixelIdsFromEnv();
  const metaPurchase = facts
    ? metaPurchaseFromPaidSession({
        facts,
        conversionsEnabled,
        pixelId: metaPixelIds.length > 0 ? metaPixelIds.join(',') : null,
      })
    : null;
  const smsNumber = readSmsNumber(process.env.NEXT_PUBLIC_HALE_SMS_NUMBER);
  const textHref = smsNumber ? buildSmsHref(smsNumber, null, intakePrefill(locale)) : null;
  const opened = paid && sessionId ? await openPricingCheckout(sessionId) : null;
  const direct =
    opened?.direct === true
      ? opened
      : facts?.direct === true
        ? {
            direct: true as const,
            bound: false,
            phone: null,
            tier: facts.tier,
            status: 'send_failed',
          }
        : null;
  const view = direct ? null : checkoutViewForPage(sessionId, facts);
  const platform = view ? await requestPlatform() : 'unknown';

  return (
    <>
      <SiteHeader locale={locale} />
      <div className="rd">
        <main id="main" className="sp-hero">
          {direct && sessionId ? (
            <PricingCheckoutVerify
              sessionId={sessionId}
              initialPhone={direct.phone}
              initialStatus={direct.status}
              initialBound={direct.bound}
              locale={locale}
              smsNumber={smsNumber ?? ''}
              prefill={intakePrefill(locale)}
              copy={{
                heading: t('heading'),
                plan: planName ? t('plan', { plan: planName }) : null,
                codeSent: t('codeSent'),
                codeHint: t('codeHint'),
                phoneLabel: t('phoneLabel'),
                codeLabel: t('codeLabel'),
                resend: t('resend'),
                editNumber: t('editNumber'),
                saveNumber: t('saveNumber'),
                wrongCode: t('wrongCode'),
                expired: t('expired'),
                locked: t('locked'),
                limited: t('limited'),
                cooldown: t('cooldown'),
                notSent: t('notSent'),
                phoneInvalid: t('phoneInvalid'),
                confirm: t('confirm'),
                paymentEnded: t('paymentEnded'),
                alreadyOnPlan: t('alreadyOnPlan'),
                lede: t('lede'),
                textHale: t('textHale'),
              }}
            />
          ) : view ? (
            <div className="sp-grid">
              <div className="sp-copy sp-checkout">
                <CheckoutState
                  view={view}
                  locale={locale}
                  sessionId={sessionId}
                  smsNumber={smsNumber}
                  platform={platform}
                />
              </div>
            </div>
          ) : (
            <div className="sp-grid">
              <div className="sp-copy sp-checkout">
                <h1 className="sp-h1">{paid ? t('heading') : t('unpaidHeading')}</h1>
                {paid ? (
                  <>
                    {planName ? <p className="sp-lede">{t('plan', { plan: planName })}</p> : null}
                    <p className="sp-lede">{t('lede')}</p>
                    <p className="sp-lede">
                      {textHref ? <a href={textHref}>{t('textHale')}</a> : null}
                      {textHref ? ' · ' : null}
                      <a href={`${APP_URL}/settings#billing`}>{t('continue')}</a>
                    </p>
                  </>
                ) : (
                  <p className="sp-lede">
                    {t('unpaidLede')} <a href={`${APP_URL}/settings#billing`}>{t('continue')}</a>
                  </p>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
      <SiteFooter locale={locale} />
      {googlePurchase ? <GooglePurchaseConversion {...googlePurchase} /> : null}
      {metaPurchase ? <MetaPurchaseConversion {...metaPurchase} /> : null}
    </>
  );
}
