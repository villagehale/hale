import { NextResponse } from 'next/server';
import {
  checkoutSessionIdFromUnknown,
  paidCheckoutFactsFromStripeSession,
} from '~/lib/billing/checkout-session';
import {
  checkoutViewFromSession,
  sessionFactsFromStripe,
} from '~/lib/billing/checkout-success-view';
import { checkoutSuccessStatesEnabled } from '~/lib/billing/flags';
import { stripeCheckoutClientFromEnv } from '~/lib/billing/stripe-client';
import { findHaleDirectChat } from '~/lib/channel/outbound-transport';
import { isParentRole } from '~/lib/channel/role-scope';
import { db as defaultDb } from '~/lib/db';
import { pageOps } from '~/lib/monitoring/failure-page';
import { rateLimitStatus } from '~/lib/rate-limit/apply';

export const runtime = 'nodejs';

const UNCACHED = { 'cache-control': 'private, no-store' };

/**
 * GET /api/billing/checkout-session?session_id=cs_…
 *
 * Returns paid/value/currency/transactionId/tier from Stripe. No email, no
 * family. The marketing success page needs these to show the verified plan
 * and fire Google Ads; it must not read value or currency from the query string.
 *
 * The session id is not a secret: it rides in the success URL that analytics, referrers
 * and screenshots carry, and it is the purchase id Google and Meta receive. So it alone
 * unlocks only those Stripe facts. With CHECKOUT_SUCCESS_STATES_ENABLED, `view` (the page
 * state, and with it the family reads, the Linq read and the #ops page) is computed only
 * for a signed-in parent of the family that session paid for.
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
    if (
      !(await signedInParentOfPayingFamily(session)) ||
      !(await rateLimitStatus('checkout-session-view', sessionId)).allowed
    ) {
      return NextResponse.json(facts, { status: 200, headers: UNCACHED });
    }
    const view = await checkoutViewFromSession(session, facts.tier, {
      database: defaultDb,
      page: pageOps,
      findDirectChat: (phone) => findHaleDirectChat(phone),
    });
    return NextResponse.json({ ...facts, view }, { status: 200, headers: UNCACHED });
  } catch {
    return NextResponse.json({ error: 'stripe_retrieve_failed' }, { status: 502 });
  }
}

async function signedInParentOfPayingFamily(session: unknown): Promise<boolean> {
  const { familyId } = sessionFactsFromStripe(session, null, new Date());
  if (familyId === null) return false;
  // Imported here, not at the top, so the flag-off route never loads Auth.js.
  const { auth } = await import('~/auth');
  const { listSeatsForUser, resolveUserIdForUser } = await import('~/lib/family');
  const externalAuthId = (await auth())?.user?.id;
  if (!externalAuthId) return false;
  // A viewer this cannot place gets the Stripe facts, which every holder of the id may
  // read, so the page still confirms the charge and the purchase still reaches Google.
  try {
    const database = defaultDb();
    const userId = await resolveUserIdForUser(externalAuthId, database);
    if (userId === null) return false;
    const seats = await listSeatsForUser(userId, database);
    return seats.some((seat) => seat.familyId === familyId && isParentRole(seat.role));
  } catch (err) {
    console.warn('checkout session: viewer seat read failed', {
      err: err instanceof Error ? err.name : 'unknown',
    });
    return false;
  }
}
