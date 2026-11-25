import { NextResponse } from 'next/server';
import { pricingCheckoutSessionId, sendPricingCheckoutCode } from '~/lib/billing/pricing-checkout';
import { retrievePricingCheckoutSnapshot } from '~/lib/billing/pricing-checkout-stripe';
import { createOtpSender } from '~/lib/channels/otp-sender';
import { db } from '~/lib/db';

export const dynamic = 'force-dynamic';

/** Resend, or send a fresh code to a corrected number. The previous code is consumed. */
export async function POST(request: Request): Promise<Response> {
  const body = await readBody(request);
  const sessionId = pricingCheckoutSessionId(body?.sessionId);
  if (!sessionId)
    return NextResponse.json({ direct: false, status: 'no_payment' }, { status: 400 });
  const phone = typeof body?.phone === 'string' ? body.phone.slice(0, 24) : null;
  try {
    const result = await sendPricingCheckoutCode(db(), {
      sessionId,
      phone,
      resend: body?.resend === true,
      now: new Date(),
      sender: createOtpSender(),
      retrieve: retriever(),
    });
    return NextResponse.json(result);
  } catch (err) {
    console.warn(
      { event: 'pricing_checkout_code_failed', name: err instanceof Error ? err.name : 'unknown' },
      'pricing checkout',
    );
    return NextResponse.json({ direct: false, status: 'send_failed' }, { status: 500 });
  }
}

function retriever():
  | ((sessionId: string) => ReturnType<typeof retrievePricingCheckoutSnapshot>)
  | undefined {
  const secret = process.env.STRIPE_SECRET_KEY?.trim();
  if (!secret) return undefined;
  return (sessionId) => retrievePricingCheckoutSnapshot(sessionId, secret);
}

async function readBody(
  request: Request,
): Promise<{ sessionId?: unknown; phone?: unknown; resend?: unknown } | null> {
  const text = await request.text();
  if (text.length > 2000) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as { sessionId?: unknown; phone?: unknown; resend?: unknown })
      : null;
  } catch {
    return null;
  }
}
