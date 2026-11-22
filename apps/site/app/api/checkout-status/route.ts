import { NextResponse } from 'next/server';
import {
  checkoutSessionIdFromSearch,
  checkoutSuccessStatesEnabled,
  fetchCheckoutSessionFacts,
} from '~/lib/billing/checkout-success';

const NO_STORE = { 'cache-control': 'no-store' };

/**
 * GET /api/checkout-status?session_id=cs_…
 *
 * What the pending success page polls. Answers only whether the wait is over: the state
 * itself, and any name on it, stay with the page render.
 */
export async function GET(req: Request): Promise<Response> {
  if (!checkoutSuccessStatesEnabled()) {
    return new Response(null, { status: 404 });
  }
  const sessionId = checkoutSessionIdFromSearch({
    session_id: new URL(req.url).searchParams.get('session_id') ?? undefined,
  });
  if (!sessionId) {
    return NextResponse.json({ error: 'invalid_session' }, { status: 400, headers: NO_STORE });
  }
  const facts = await fetchCheckoutSessionFacts(sessionId);
  const settled = facts?.view !== undefined && facts.view.state !== 'pending';
  return NextResponse.json({ settled }, { status: 200, headers: NO_STORE });
}
