import { type BillingPeriod, resolveBlackFridayNow } from '@hale/types';
import { NextResponse } from 'next/server';
import { auth } from '~/auth';
import { cookieHeaderHasAnalyticsOptOut } from '~/lib/analytics/opt-out';
import { adsContextFromRequest } from '~/lib/billing/ads-context';
import { attributionFromRequest } from '~/lib/billing/attribution';
import { billingWebhookReady } from '~/lib/billing/billing-live';
import { decideCheckoutCurrency, decideCheckoutTier } from '~/lib/billing/checkout-request';
import { checkoutMarketingOrigin } from '~/lib/billing/checkout-session';
import { createBillingCheckout } from '~/lib/billing/create-checkout';
import { holidayPromoEnabled } from '~/lib/billing/flags';
import {
  foundingWindowOpen,
  isPromoAnnualSku,
  paidTierFromSku,
  resolveCheckoutPrice,
} from '~/lib/billing/prices';
import { familyMayUseFoundingCheckout } from '~/lib/billing/promo-access';
import { stripeCheckoutClientFromEnv } from '~/lib/billing/stripe-client';
import { db as defaultDb } from '~/lib/db';
import { resolveFamilyForUser } from '~/lib/family';
import { MARKETING_SITE_URL } from '~/lib/legal-links';

export const runtime = 'nodejs';

const PERIODS: ReadonlySet<string> = new Set<BillingPeriod>(['monthly', 'annual']);

/**
 * POST /api/billing/checkout — founding / Plus Stripe Checkout for a signed-in family.
 *
 * Dark unless HOLIDAY_PROMO_ENABLED is exactly `true` (404, same as the deleted
 * route). Currency comes from `x-vercel-ip-country`. With
 * CHECKOUT_SERVER_CURRENCY_ENABLED exactly `true`, only US → USD and CA → CAD
 * are charged, and a client currency never picks the price. The promo window
 * is enforced here, not in Stripe. Attribution from the hale_attr cookie,
 * query, and body is copied into Stripe metadata. When
 * STRIPE_BILLING_REVOKE_ENABLED is exactly `true`, this also stays 501 until
 * STRIPE_WEBHOOK_SECRET is set and a signed event has been applied.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  const externalAuthId = session?.user?.id;
  const url = new URL(req.url);
  const now = resolveBlackFridayNow({
    now: new Date(),
    env: process.env,
    bf: url.searchParams.get('bf'),
    bfNow: url.searchParams.get('bf_now'),
  });
  const live = holidayPromoEnabled();
  if (!live) {
    if (!externalAuthId) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    const familyId = await resolveFamilyForUser(externalAuthId, defaultDb());
    if (!familyMayUseFoundingCheckout(familyId, now)) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
  } else if (!externalAuthId) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    period?: unknown;
    /** plus | family | max. With the server-currency flag, unknown values are 400. */
    tier?: unknown;
    /** Promo confirmation refuses a silent fallback to a list price. */
    offer?: unknown;
    expectedCurrency?: unknown;
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
  const tierDecision = decideCheckoutTier(body?.tier);
  if (tierDecision.status === 'invalid_tier') {
    return NextResponse.json({ error: 'invalid_tier' }, { status: 400 });
  }
  const tier = tierDecision.tier;
  const currencyDecision = decideCheckoutCurrency({
    countryHeader: req.headers.get('x-vercel-ip-country'),
    expectedCurrency: body?.expectedCurrency,
  });
  if (currencyDecision.status !== 'ok') {
    return NextResponse.json(
      { error: currencyDecision.status },
      { status: currencyDecision.status === 'region_unsupported' ? 403 : 409 },
    );
  }
  const currency = currencyDecision.currency;
  const selected = resolveCheckoutPrice({
    currency,
    period,
    now,
    preview: !live,
    tier,
  });
  if (
    foundingWindowOpen(now) &&
    selected.status === 'selected' &&
    !isPromoAnnualSku(selected.price.sku)
  ) {
    return NextResponse.json({ error: 'founding_unavailable' }, { status: 409 });
  }
  const wantsPromo = body?.offer === 'founding' || body?.offer === 'promo';
  if (wantsPromo && (selected.status !== 'selected' || !isPromoAnnualSku(selected.price.sku))) {
    return NextResponse.json({ error: 'founding_unavailable' }, { status: 409 });
  }
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
  const webhook = await billingWebhookReady(defaultDb());
  if (!webhook.ready) {
    return NextResponse.json(
      { error: 'stripe_billing_not_live', reason: webhook.reason },
      { status: 501 },
    );
  }

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
      tier: paidTierFromSku(selected.price.sku),
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
      analyticsOptOut: cookieHeaderHasAnalyticsOptOut(req.headers.get('cookie')),
    });
    if (result.status === 'not_found') {
      return NextResponse.json({ error: 'no_family' }, { status: 404 });
    }
    if (result.status === 'already_paid') {
      return NextResponse.json({ error: 'already_paid' }, { status: 409 });
    }
    if (result.status === 'founding_only') {
      return NextResponse.json({ error: 'founding_unavailable' }, { status: 409 });
    }
    return NextResponse.json({ url: result.url }, { status: 200 });
  } catch {
    return NextResponse.json({ error: 'stripe_checkout_failed' }, { status: 502 });
  }
}
