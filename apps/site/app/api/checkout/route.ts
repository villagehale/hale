import { ANALYTICS_DISTINCT_ID_KEY } from '@hale/types';
import { NextResponse } from 'next/server';
import { adsCurrency, metaEventSourceUrl, sendSiteMetaCapi } from '~/lib/analytics/meta-capi';
import { captureSiteCheckoutStarted } from '~/lib/analytics/server-capture';
import { adsContextFromRequest } from '~/lib/billing/ads-context';
import { CHECKOUT_JSON_HEADER } from '~/lib/billing/checkout-client';
import {
  attributionFromCheckoutUrl,
  directCheckoutCancelUrl,
  directCheckoutForm,
  directCheckoutSuccessUrl,
  directCheckoutTier,
  isCheckoutPrefetch,
  selectDirectCheckoutPrice,
  stripeHostedCheckoutUrl,
} from '~/lib/billing/direct-checkout';
import { visitorCurrencyFromHeaders } from '~/lib/billing/visitor-currency';

export const dynamic = 'force-dynamic';

/**
 * Plus and Max on /pricing. A GET so the button is a link. Nothing is created
 * before Stripe: no code, no account. The browser is sent to Checkout.
 */
export async function GET(request: Request): Promise<Response> {
  if (isCheckoutPrefetch(request)) return new NextResponse(null, { status: 204 });

  const url = new URL(request.url);
  const tier = directCheckoutTier(url.searchParams.get('tier'));
  if (!tier) return NextResponse.json({ error: 'invalid_tier' }, { status: 400 });

  const currency = visitorCurrencyFromHeaders(request.headers);
  if (!currency) return NextResponse.json({ error: 'region_unsupported' }, { status: 403 });

  const selected = selectDirectCheckoutPrice({ tier, currency, now: new Date() });
  if (selected.status === 'unavailable' && selected.reason === 'flag_off') {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (selected.status === 'unavailable') {
    return NextResponse.json(
      { error: 'stripe_billing_not_live', reason: 'no_price' },
      { status: 501 },
    );
  }

  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) {
    return NextResponse.json(
      { error: 'stripe_billing_not_live', reason: 'no_key' },
      { status: 501 },
    );
  }

  const origin = url.origin;
  const attribution = attributionFromCheckoutUrl(url);
  const distinctId = url.searchParams.get(ANALYTICS_DISTINCT_ID_KEY);
  const ads = adsContextFromRequest({
    cookieHeader: request.headers.get('cookie'),
    headers: request.headers,
    fbclid: attribution.fbclid,
  });
  const form = directCheckoutForm({
    priceId: selected.priceId,
    tier: selected.tier,
    sku: selected.sku,
    currency: selected.currency,
    successUrl: directCheckoutSuccessUrl(origin),
    cancelUrl: directCheckoutCancelUrl(origin),
    attribution,
    analyticsDistinctId: distinctId,
    ads,
  });

  let checkoutUrl: string | null = null;
  let sessionId: string | null = null;
  let checkoutValue: number | null = null;
  let checkoutCurrency: 'CAD' | 'USD' | null = null;
  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    if (!res.ok) {
      console.warn(
        { event: 'pricing_checkout_create_failed', status: res.status },
        'pricing checkout',
      );
      return NextResponse.json({ error: 'stripe_unavailable' }, { status: 502 });
    }
    const json = (await res.json()) as {
      url?: unknown;
      id?: unknown;
      amount_total?: unknown;
      currency?: unknown;
    };
    checkoutUrl = stripeHostedCheckoutUrl(json.url);
    sessionId = typeof json.id === 'string' ? json.id : null;
    const currency = adsCurrency(
      typeof json.currency === 'string' ? json.currency : selected.currency,
    );
    const cents =
      typeof json.amount_total === 'number' && Number.isFinite(json.amount_total)
        ? json.amount_total
        : null;
    checkoutValue = currency && cents !== null && cents >= 0 ? cents / 100 : null;
    checkoutCurrency = currency;
  } catch (err) {
    console.warn(
      {
        event: 'pricing_checkout_create_failed',
        name: err instanceof Error ? err.name : 'unknown',
      },
      'pricing checkout',
    );
    return NextResponse.json({ error: 'stripe_unavailable' }, { status: 502 });
  }
  if (!checkoutUrl) return NextResponse.json({ error: 'stripe_unavailable' }, { status: 502 });

  if (sessionId) {
    try {
      await captureSiteCheckoutStarted({
        sessionId,
        tier: selected.tier,
        sku: selected.sku,
        currency: selected.currency,
        attribution,
        analyticsDistinctId: distinctId,
      });
    } catch (err) {
      console.warn(
        {
          event: 'pricing_checkout_started_failed',
          name: err instanceof Error ? err.name : 'unknown',
        },
        'pricing checkout',
      );
    }
    const consentedCheckout = request.headers.get(CHECKOUT_JSON_HEADER) === 'json';
    if (consentedCheckout && checkoutCurrency && checkoutValue !== null) {
      try {
        const sourceUrl = metaEventSourceUrl(request.headers.get('referer'));
        if (!sourceUrl) {
          console.info('analytics: meta capi skipped', {
            reason: 'no_source',
            event: 'InitiateCheckout',
          });
        } else {
          await sendSiteMetaCapi({
            eventName: 'InitiateCheckout',
            eventId: sessionId,
            sourceUrl,
            value: checkoutValue,
            currency: checkoutCurrency,
            ads,
          });
        }
      } catch (err) {
        console.warn(
          {
            event: 'pricing_checkout_meta_failed',
            name: err instanceof Error ? err.name : 'unknown',
          },
          'pricing checkout',
        );
      }
    }
  }

  if (request.headers.get(CHECKOUT_JSON_HEADER) === 'json') {
    return NextResponse.json(
      {
        url: checkoutUrl,
        sessionId,
        ...(checkoutCurrency && checkoutValue !== null
          ? { value: checkoutValue, currency: checkoutCurrency }
          : {}),
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  return new NextResponse(null, {
    status: 303,
    headers: { location: checkoutUrl, 'cache-control': 'no-store' },
  });
}
