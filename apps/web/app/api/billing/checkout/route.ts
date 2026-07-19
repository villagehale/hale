import { NextResponse } from 'next/server';
import type { BillingPeriod } from '@hale/types';
import { auth } from '~/auth';
import { createBillingCheckout } from '~/lib/billing/create-checkout';
import { stripeCheckoutClientFromEnv } from '~/lib/billing/stripe-client';
import { db as defaultDb } from '~/lib/db';
import {
  checkoutPriceIdFromEnv,
  isStripeCheckoutConfigured,
  type PaidTier,
} from '~/lib/webhooks/stripe-billing';

export const runtime = 'nodejs';

const PAID_TIERS: ReadonlySet<string> = new Set<PaidTier>(['plus', 'family']);
const PERIODS: ReadonlySet<string> = new Set<BillingPeriod>(['monthly', 'annual']);

/**
 * POST /api/billing/checkout — creates a Stripe Checkout session for a paid tier and
 * returns its redirect url. WEB-ONLY (Apple IAP policy forbids a mobile app opening a
 * Stripe web checkout for digital goods — the native plan page stays read-only).
 *
 * Honest posture, mirroring the webhook billing gate: absent Stripe keys this returns
 * 501 `stripe_billing_not_live` — byte-identical dormant behaviour. auth() is the 401
 * gate; a caller with no family gets 404; the billing intent is audited (rule #6) in
 * createBillingCheckout. The Stripe call is the only external boundary — a failure
 * there is a 502, never a bare 500.
 */
export async function POST(req: Request): Promise<Response> {
  const session = await auth();
  const externalAuthId = session?.user?.id;
  const email = session?.user?.email;
  if (!externalAuthId || !email) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    tier?: unknown;
    period?: unknown;
  } | null;
  const tier = body?.tier;
  const period = body?.period ?? 'monthly';
  if (typeof tier !== 'string' || !PAID_TIERS.has(tier)) {
    return NextResponse.json({ error: 'invalid_tier' }, { status: 400 });
  }
  if (typeof period !== 'string' || !PERIODS.has(period)) {
    return NextResponse.json({ error: 'invalid_period' }, { status: 400 });
  }

  if (!isStripeCheckoutConfigured()) {
    return NextResponse.json(
      { error: 'stripe_billing_not_live', detail: 'Paid plans are not available yet.' },
      { status: 501 },
    );
  }
  const priceId = checkoutPriceIdFromEnv(tier as PaidTier, period as BillingPeriod);
  const client = stripeCheckoutClientFromEnv();
  // Pin the redirect origin to APP_URL — never the request Host header, which a
  // caller can steer (an open-redirect / spoofed success page). Absent APP_URL is
  // treated as not-configured, the same honest 501 as missing Stripe keys.
  const origin = process.env.APP_URL;
  if (!priceId || !client || !origin) {
    return NextResponse.json({ error: 'stripe_billing_not_live' }, { status: 501 });
  }

  let result: Awaited<ReturnType<typeof createBillingCheckout>>;
  try {
    result = await createBillingCheckout({
      tier: tier as PaidTier,
      period: period as BillingPeriod,
      priceId,
      identity: { externalAuthId, email, name: session.user?.name ?? null },
      database: defaultDb(),
      client,
      origin,
    });
  } catch {
    return NextResponse.json({ error: 'stripe_checkout_failed' }, { status: 502 });
  }

  if (result.status === 'not_found') {
    return NextResponse.json({ error: 'no_family' }, { status: 404 });
  }
  return NextResponse.json({ url: result.url }, { status: 200 });
}
