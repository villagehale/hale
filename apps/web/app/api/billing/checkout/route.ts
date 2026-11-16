import { NextResponse } from 'next/server';
import type { BillingPeriod } from '@hale/types';
import { currencyFromIpCountry } from '@hale/types';
import { auth } from '~/auth';
import { adsContextFromRequest } from '~/lib/billing/ads-context';
import { attributionFromRequest } from '~/lib/billing/attribution';
import { createBillingCheckout } from '~/lib/billing/create-checkout';
import { holidayPromoEnabled } from '~/lib/billing/flags';
import { resolveCheckoutPrice } from '~/lib/billing/prices';
import { checkoutMarketingOrigin } from '~/lib/billing/checkout-session';
import { stripeCheckoutClientFromEnv } from '~/lib/billing/stripe-client';
import { db as defaultDb } from '~/lib/db';
import { MARKETING_SITE_URL } from '~/lib/legal-links';

export const runtime = 'nodejs';

const PERIODS: ReadonlySet<string> = new Set<BillingPeriod>(['monthly', 'annual']);

/**
 * POST /api/billing/checkout — founding / Plus Stripe Checkout for a signed-in family.
 *
 * Dark unless HOLIDAY_PROMO_ENABLED is exactly `true` (404, same as the deleted
 * route). Currency comes from `x-vercel-ip-country` (US → USD, else CAD). The
 * promo window is enforced here, not in Stripe. Attribution from the hale_attr
 * cookie, query, and body is copied into Stripe metadata.
 */
export async function POST(req: Request): Promise<Response> {
  if (!holidayPromoEnabled()) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const session = await auth();
  const externalAuthId = session?.user?.id;
  if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    period?: unknown;
    utm_source?: unknown;
    utm_medium?: unknown;
    utm_campaign?: unknown;
    utm_term?: unknown;
    utm_content?: unknown;
    gclid?: unknown;
    fbclid?: unknown;
  } | null;

  const periodRaw = body?.period ?? 'annual';
  if (typeof periodRaw !== 'string' || !PERIODS.has(periodRaw)) {
    return NextResponse.json({ error: 'invalid_period' }, { status: 400 });
  }
  const period = periodRaw as BillingPeriod;
  const currency = currencyFromIpCountry(req.headers.get('x-vercel-ip-country'));
  const selected = resolveCheckoutPrice({ currency, period, now: new Date() });
  if (selected.status === 'unavailable') {
    return NextResponse.json(
      { error: 'stripe_billing_not_live', reason: selected.reason },
      { status: 501 },
    );
  }

  const client = stripeCheckoutClientFromEnv();
  const origin = process.env.APP_URL;
  if (!client || !origin) {
    return NextResponse.json({ error: 'stripe_billing_not_live' }, { status: 501 });
  }

  const url = new URL(req.url);
  const attribution = attributionFromRequest({
    cookieHeader: req.headers.get('cookie'),
    search: url.searchParams,
    body,
  });
  const adsContext = adsContextFromRequest({
    cookieHeader: req.headers.get('cookie'),
    headers: req.headers,
    fbclid: attribution.fbclid ?? null,
  });

  try {
    const result = await createBillingCheckout({
      tier: 'plus',
      period: selected.price.period,
      priceId: selected.price.priceId,
      sku: selected.price.sku,
      currency: selected.price.currency,
      attribution,
      adsContext,
      externalAuthId,
      customerEmail: session.user?.email ?? null,
      database: defaultDb(),
      client,
      origin,
      marketingOrigin: checkoutMarketingOrigin(MARKETING_SITE_URL, process.env),
    });
    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'no_family' }, { status: 404 });
    }
    if (result.status === 'already_paid') {
      return NextResponse.json({ error: 'already_paid' }, { status: 409 });
    }
    return NextResponse.json({ url: result.url }, { status: 200 });
  } catch {
    return NextResponse.json({ error: 'stripe_checkout_failed' }, { status: 502 });
  }
}
