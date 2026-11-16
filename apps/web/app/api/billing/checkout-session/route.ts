import { NextResponse } from 'next/server';
import {
  checkoutSessionIdFromUnknown,
  paidCheckoutFactsFromStripeSession,
} from '~/lib/billing/checkout-session';
import { stripeCheckoutClientFromEnv } from '~/lib/billing/stripe-client';

export const runtime = 'nodejs';

/**
 * GET /api/billing/checkout-session?session_id=cs_…
 *
 * Returns paid/value/currency/transactionId from Stripe. No email, no family,
 * no metadata. The marketing success page needs these to fire Google Ads in
 * the browser; it must not read value or currency from the query string.
 */
export async function GET(req: Request): Promise<Response> {
  const sessionId = checkoutSessionIdFromUnknown(
    new URL(req.url).searchParams.get('session_id'),
  );
  if (!sessionId) {
    return NextResponse.json({ error: 'invalid_session' }, { status: 400 });
  }

  const client = stripeCheckoutClientFromEnv();
  if (!client?.retrieveCheckoutSession) {
    return NextResponse.json({ error: 'stripe_billing_not_live' }, { status: 501 });
  }

  try {
    const session = await client.retrieveCheckoutSession(sessionId);
    const facts = paidCheckoutFactsFromStripeSession(session);
    if (!facts) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    return NextResponse.json(facts, { status: 200 });
  } catch {
    return NextResponse.json({ error: 'stripe_retrieve_failed' }, { status: 502 });
  }
}
