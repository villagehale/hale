import { NextResponse } from 'next/server';
import {
  checkoutSessionIdFromUnknown,
  paidCheckoutFactsFromStripeSession,
} from '~/lib/billing/checkout-session';
import { checkoutViewFromSession } from '~/lib/billing/checkout-success-view';
import { checkoutSuccessStatesEnabled } from '~/lib/billing/flags';
import { stripeCheckoutClientFromEnv } from '~/lib/billing/stripe-client';
import { findHaleDirectChat } from '~/lib/channel/outbound-transport';
import { db as defaultDb } from '~/lib/db';
import { pageOps } from '~/lib/monitoring/failure-page';

export const runtime = 'nodejs';

/**
 * GET /api/billing/checkout-session?session_id=cs_…
 *
 * Returns paid/value/currency/transactionId/tier from Stripe. No email, no
 * family. The marketing success page needs these to show the verified plan
 * and fire Google Ads; it must not read value or currency from the query string.
 * With CHECKOUT_SUCCESS_STATES_ENABLED it also sends `view`, the page state: the
 * URL is the only key to this route, so `view` says no more than that page shows.
 */
export async function GET(req: Request): Promise<Response> {
  const sessionId = checkoutSessionIdFromUnknown(new URL(req.url).searchParams.get('session_id'));
  if (!sessionId) {
    return NextResponse.json({ error: 'invalid_session' }, { status: 400 });
  }

  const client = stripeCheckoutClientFromEnv();
  if (!client?.retrieveCheckoutSession) {
    return NextResponse.json({ error: 'stripe_billing_not_live' }, { status: 501 });
  }

  try {
    const statesEnabled = checkoutSuccessStatesEnabled();
    const session = statesEnabled
      ? await client.retrieveCheckoutSession(sessionId, { expand: ['subscription'] })
      : await client.retrieveCheckoutSession(sessionId);
    const facts = paidCheckoutFactsFromStripeSession(session);
    if (!facts) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (!statesEnabled) {
      return NextResponse.json(facts, { status: 200 });
    }
    const view = await checkoutViewFromSession(session, facts.tier, {
      database: defaultDb,
      page: pageOps,
      findDirectChat: (phone) => findHaleDirectChat(phone),
    });
    return NextResponse.json(
      { ...facts, view },
      { status: 200, headers: { 'cache-control': 'private, no-store' } },
    );
  } catch {
    return NextResponse.json({ error: 'stripe_retrieve_failed' }, { status: 502 });
  }
}
