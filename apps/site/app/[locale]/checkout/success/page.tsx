import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { CheckoutState } from '~/components/checkout/checkout-state';
import { PricingCheckoutVerify } from '~/components/checkout/pricing-verify';
import { shoreSrc } from '~/components/redesign/assets';
import { tx } from '~/components/redesign/tx';
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
import { PLUS_SIGNUP_LINE, REFUND_EMAIL } from '~/lib/site/narrative';
import { buildSmsHref, readSmsNumber } from '~/lib/text-entry';

interface PageProps {
  params: Promise<{ locale: Locale }>;
  searchParams?: Promise<{
    session_id?: string | string[];
    value?: string | string[];
    currency?: string | string[];
  }>;
}

const successCopyStyle = { fontFamily: 'var(--font-ui)', color: 'var(--navy)' } as const;

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
        <div className="stage sp-stage">
          <img className="shore-art" src={shoreSrc} alt="" aria-hidden="true" />
          <span className="shore-drift sky" aria-hidden="true" />
          <span className="shore-drift sea" aria-hidden="true" />
          <span className="shore-scrim" aria-hidden="true" />
          <main id="main" className="sp-hero">
            {direct && sessionId ? (
              <PricingCheckoutVerify
                sessionId={sessionId}
                initialPhone={direct.phone}
                initialStatus={direct.status}
                initialBound={direct.bound}
                tier={direct.tier}
                locale={locale}
                smsNumber={smsNumber ?? ''}
                prefill={intakePrefill(locale)}
                refundEmail={REFUND_EMAIL}
                copy={{
                  memberPlus: t('memberPlus'),
                  memberMax: t('memberMax'),
                  welcomePlus: t('welcomePlus'),
                  welcomeMax: t('welcomeMax'),
                  priceLocked: t('priceLocked'),
                  verifyPrompt: t('verifyPrompt'),
                  sayHi: t('sayHi'),
                  inPlus: t('inPlus'),
                  inMax: t('inMax'),
                  knowsTitle: tx(locale, 'Knows your family'),
                  knowsLine: t('knowsLine'),
                  findsTitle: tx(locale, 'Finds what fits'),
                  findsLine: t('findsLine'),
                  chatTitle: tx(locale, 'Runs the group chat'),
                  chatLine: t('chatLine'),
                  spotTitle: tx(locale, 'Gets the spot'),
                  spotLine: tx(locale, PLUS_SIGNUP_LINE),
                  maxEverything: tx(locale, 'Everything in Plus'),
                  maxLimits: t('maxLimits'),
                  maxSupport: tx(locale, 'Priority support'),
                  refund: t.raw('refund'),
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
                  textHale: t('textHale'),
                }}
              />
            ) : view ? (
              <div className="sp-grid">
                <div className="hs-glass sp-card sp-aside">
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
                <div className="hs-glass sp-card sp-aside">
                  <h1 className="hs-h2">{paid ? t('heading') : t('unpaidHeading')}</h1>
                  {paid ? (
                    <>
                      {planName ? (
                        <p className="hs-p" style={successCopyStyle}>
                          {t('plan', { plan: planName })}
                        </p>
                      ) : null}
                      <p className="hs-p" style={successCopyStyle}>
                        {t('lede')}
                      </p>
                      <p className="hs-p" style={successCopyStyle}>
                        {textHref ? <a href={textHref}>{t('textHale')}</a> : null}
                        {textHref ? ' · ' : null}
                        <a href={`${APP_URL}/settings#billing`}>{t('continue')}</a>
                      </p>
                    </>
                  ) : (
                    <p className="hs-p" style={successCopyStyle}>
                      {t('unpaidLede')} <a href={`${APP_URL}/settings#billing`}>{t('continue')}</a>
                    </p>
                  )}
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
      <SiteFooter locale={locale} />
      {googlePurchase ? <GooglePurchaseConversion {...googlePurchase} /> : null}
      {metaPurchase ? <MetaPurchaseConversion {...metaPurchase} /> : null}
    </>
  );
}
