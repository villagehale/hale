import { NextResponse } from 'next/server';
import {
  pricingCheckoutSessionId,
  rememberStripeCustomer,
  verifyPricingCheckoutCode,
} from '~/lib/billing/pricing-checkout';
import {
  annotatePricingSubscription,
  cancelPricingSubscription,
} from '~/lib/billing/pricing-checkout-stripe';
import { db } from '~/lib/db';

export const dynamic = 'force-dynamic';

/**
 * Verifies the code for this session. The bound number is the one stored with
 * the code. A later invoice can find the family only if the subscription
 * metadata patch lands; a failed patch leaves the bind in place.
 */
export async function POST(request: Request): Promise<Response> {
  const body = await readBody(request);
  const sessionId = pricingCheckoutSessionId(body?.sessionId);
  if (!sessionId) return NextResponse.json({ status: 'no_payment' }, { status: 400 });
  const code = typeof body?.code === 'string' ? body.code.slice(0, 12) : '';
  if (!code) return NextResponse.json({ status: 'wrong_code' }, { status: 400 });
  try {
    const result = await verifyPricingCheckoutCode(db(), { sessionId, code, now: new Date() });
    const secret = process.env.STRIPE_SECRET_KEY?.trim() ?? '';
    if (result.status === 'verified' && result.familyId) {
      await rememberStripeCustomer(db(), result.familyId, result.customerId, result.subscriptionId);
      if (secret && result.subscriptionId) {
        try {
          await annotatePricingSubscription(secret, result.subscriptionId, result.familyId);
        } catch (err) {
          console.warn(
            {
              event: 'pricing_checkout_annotate_failed',
              name: err instanceof Error ? err.name : 'unknown',
            },
            'pricing checkout',
          );
        }
      }
    }
    if (result.status === 'already_subscribed' && result.subscriptionId) {
      try {
        await cancelPricingSubscription(secret, result.subscriptionId);
      } catch (err) {
        console.warn(
          {
            event: 'pricing_checkout_cancel_failed',
            name: err instanceof Error ? err.name : 'unknown',
          },
          'pricing checkout',
        );
      }
    }
    return NextResponse.json({
      status: result.status,
      ...(result.attemptsRemaining !== undefined
        ? { attemptsRemaining: result.attemptsRemaining }
        : {}),
    });
  } catch (err) {
    console.warn(
      {
        event: 'pricing_checkout_verify_failed',
        name: err instanceof Error ? err.name : 'unknown',
      },
      'pricing checkout',
    );
    return NextResponse.json({ status: 'no_pending' }, { status: 500 });
  }
}

async function readBody(request: Request): Promise<{ sessionId?: unknown; code?: unknown } | null> {
  const text = await request.text();
  if (text.length > 2000) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as { sessionId?: unknown; code?: unknown })
      : null;
  } catch {
    return null;
  }
}
