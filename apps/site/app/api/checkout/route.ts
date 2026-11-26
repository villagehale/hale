import { NextResponse } from 'next/server';
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
  const form = directCheckoutForm({
    priceId: selected.priceId,
    tier: selected.tier,
    sku: selected.sku,
    currency: selected.currency,
    successUrl: directCheckoutSuccessUrl(origin),
    cancelUrl: directCheckoutCancelUrl(origin),
    attribution: attributionFromCheckoutUrl(url),
  });

  let checkoutUrl: string | null = null;
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
    const json = (await res.json()) as { url?: unknown };
    checkoutUrl = stripeHostedCheckoutUrl(json.url);
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

  return new NextResponse(null, {
    status: 303,
    headers: { location: checkoutUrl, 'cache-control': 'no-store' },
  });
}
