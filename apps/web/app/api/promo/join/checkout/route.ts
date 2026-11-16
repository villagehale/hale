import { currencyFromIpCountry } from '@hale/types';
import { NextResponse } from 'next/server';
import { adsContextFromRequest } from '~/lib/billing/ads-context';
import { attributionFromRequest } from '~/lib/billing/attribution';
import { checkoutMarketingOrigin } from '~/lib/billing/checkout-session';
import { createBillingCheckout } from '~/lib/billing/create-checkout';
import { isPromoAnnualSku, paidTierFromUnknown, resolveCheckoutPrice } from '~/lib/billing/prices';
import { newVisitorFoundingAllowedFromRequest } from '~/lib/billing/promo-access';
import { PROMO_JOIN_COOKIE, readPromoJoinBinding } from '~/lib/billing/promo-join-cookie';
import {
  promoPreviewCookieFromHeader,
  promoPreviewTokenFromSearch,
  promoPreviewTokenMatches,
  readPromoPreviewCookie,
} from '~/lib/billing/promo-preview';
import { stripeCheckoutClientFromEnv } from '~/lib/billing/stripe-client';
import { db as defaultDb } from '~/lib/db';
import { MARKETING_SITE_URL } from '~/lib/legal-links';

export const runtime = 'nodejs';

/**
 * POST /api/promo/join/checkout — Stripe Checkout for the pending family bound
 * by the join cookie. No Auth.js session: the parent has not texted Hale yet.
 */
export async function POST(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const token = promoPreviewTokenFromSearch(url.searchParams);
  const now = new Date();
  if (!newVisitorFoundingAllowedFromRequest(req, now)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const cookieHeader = req.headers.get('cookie');
  const raw = cookieValue(cookieHeader, PROMO_JOIN_COOKIE);
  const binding = readPromoJoinBinding(raw ?? undefined);
  if (!binding) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const origin = process.env.APP_URL;
  const client = stripeCheckoutClientFromEnv();
  if (!client || !origin) {
    return NextResponse.json({ error: 'stripe_billing_not_live' }, { status: 501 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const tier = paidTierFromUnknown(body?.tier);
  const currency = currencyFromIpCountry(req.headers.get('x-vercel-ip-country'));
  const selected = resolveCheckoutPrice({
    currency,
    period: 'annual',
    now,
    preview:
      promoPreviewTokenMatches(token) ||
      readPromoPreviewCookie(promoPreviewCookieFromHeader(cookieHeader)),
    tier,
  });
  if (selected.status === 'unavailable' || !isPromoAnnualSku(selected.price.sku)) {
    return NextResponse.json(
      {
        error: 'stripe_billing_not_live',
        reason: selected.status === 'unavailable' ? selected.reason : 'not_promo',
      },
      { status: 501 },
    );
  }
  const attribution = attributionFromRequest({
    cookieHeader,
    search: url.searchParams,
    body,
  });
  const adsContext = adsContextFromRequest({
    cookieHeader,
    headers: req.headers,
    fbclid: attribution.fbclid ?? null,
  });

  try {
    const result = await createBillingCheckout({
      tier,
      period: selected.price.period,
      priceId: selected.price.priceId,
      sku: selected.price.sku,
      currency: selected.price.currency,
      attribution,
      adsContext,
      externalAuthId: binding.externalAuthId,
      familyId: binding.familyId,
      customerEmail: null,
      database: defaultDb(),
      client,
      origin,
      marketingOrigin: checkoutMarketingOrigin(MARKETING_SITE_URL, process.env),
      cancelUrl: `${origin}/founding?checkout=cancelled`,
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

function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}
