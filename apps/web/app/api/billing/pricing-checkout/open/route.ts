import { NextResponse } from 'next/server';
import { pricingCheckoutSessionId, sendPricingCheckoutCode } from '~/lib/billing/pricing-checkout';
import { retrievePricingCheckoutSnapshot } from '~/lib/billing/pricing-checkout-stripe';
import { createOtpSender } from '~/lib/channels/otp-sender';
import { db } from '~/lib/db';

export const dynamic = 'force-dynamic';

/**
 * The success page calls this once. A live code is not sent again. The phone
 * in the body is the Stripe number, for the field on that page only.
 */
export async function POST(request: Request): Promise<Response> {
  const sessionId = await sessionIdFrom(request);
  if (!sessionId)
    return NextResponse.json({ direct: false, status: 'no_payment' }, { status: 400 });
  try {
    const result = await sendPricingCheckoutCode(db(), {
      sessionId,
      now: new Date(),
      sender: createOtpSender(),
      retrieve: retriever(),
    });
    return NextResponse.json(result);
  } catch (err) {
    console.warn(
      { event: 'pricing_checkout_open_failed', name: err instanceof Error ? err.name : 'unknown' },
      'pricing checkout',
    );
    return NextResponse.json({ direct: false, status: 'send_failed' }, { status: 500 });
  }
}

async function sessionIdFrom(request: Request): Promise<string | null> {
  const body = await readBody(request);
  return pricingCheckoutSessionId(body?.sessionId);
}

function retriever():
  | ((sessionId: string) => ReturnType<typeof retrievePricingCheckoutSnapshot>)
  | undefined {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) return undefined;
  return (sessionId) => retrievePricingCheckoutSnapshot(sessionId, secret);
}

async function readBody(request: Request): Promise<{ sessionId?: unknown } | null> {
  const text = await request.text();
  if (text.length > 2000) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as { sessionId?: unknown })
      : null;
  } catch {
    return null;
  }
}
