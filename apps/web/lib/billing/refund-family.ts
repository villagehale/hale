import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';

/**
 * Ops path: full refund of a family's latest paid Stripe charge, then cancel
 * the subscription. Omitting `amount` on Stripe's Refunds API is a full refund
 * of that charge — no pro-rating, no time window. No parent-visible copy.
 * Dry-run unless apply is true. Named outcomes, never a silent no-op (rule #11).
 */

export type RefundFamilyResult =
  | { status: 'refunded'; familyId: string; refundId: string; subscriptionId: string }
  | { status: 'dry_run'; familyId: string; chargeId: string; subscriptionId: string }
  | { status: 'skipped'; reason: 'not_configured' | 'no_family' | 'no_customer' | 'no_payment' }
  | { status: 'failed'; reason: 'stripe_error' };

export interface StripeRefundApi {
  latestPaidCharge(
    customerId: string,
  ): Promise<{ chargeId: string; paymentIntentId: string | null } | null>;
  refundCharge(chargeId: string): Promise<{ refundId: string }>;
  cancelSubscription(subscriptionId: string): Promise<void>;
}

export async function refundFamilyLatestPayment(input: {
  familyId: string;
  apply: boolean;
  database: Database;
  stripe: StripeRefundApi | null;
  actor?: string;
}): Promise<RefundFamilyResult> {
  const { familyId, apply, database, stripe, actor = 'ops' } = input;
  if (!stripe) {
    console.info('billing refund: skipped', { reason: 'not_configured' });
    return { status: 'skipped', reason: 'not_configured' };
  }

  const rows = await database
    .select({
      id: schema.families.id,
      stripeCustomerId: schema.families.stripeCustomerId,
      stripeSubscriptionId: schema.families.stripeSubscriptionId,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  const family = rows[0];
  if (!family) {
    return { status: 'skipped', reason: 'no_family' };
  }
  if (!family.stripeCustomerId) {
    return { status: 'skipped', reason: 'no_customer' };
  }

  const latest = await stripe.latestPaidCharge(family.stripeCustomerId);
  if (!latest) {
    return { status: 'skipped', reason: 'no_payment' };
  }
  const subscriptionId = family.stripeSubscriptionId ?? '';

  if (!apply) {
    return {
      status: 'dry_run',
      familyId,
      chargeId: latest.chargeId,
      subscriptionId,
    };
  }

  try {
    const { refundId } = await stripe.refundCharge(latest.chargeId);
    if (subscriptionId) {
      await stripe.cancelSubscription(subscriptionId);
    }
    await database.insert(schema.auditLog).values({
      familyId,
      actor,
      actionTaken: 'billing_refunded',
      targetTable: 'families',
      targetId: familyId,
      after: {
        refundId,
        chargeId: latest.chargeId,
        subscriptionId: subscriptionId || null,
      },
    });
    return { status: 'refunded', familyId, refundId, subscriptionId };
  } catch {
    console.warn('billing refund: stripe_error', { familyId });
    return { status: 'failed', reason: 'stripe_error' };
  }
}

export function stripeRefundApiFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): StripeRefundApi | null {
  const secret = env.STRIPE_SECRET_KEY;
  if (!secret) return null;
  const headers = {
    authorization: `Bearer ${secret}`,
    'content-type': 'application/x-www-form-urlencoded',
  };
  return {
    async latestPaidCharge(customerId) {
      const res = await fetchImpl(
        `https://api.stripe.com/v1/charges?customer=${encodeURIComponent(customerId)}&limit=10`,
        { headers },
      );
      if (!res.ok) throw new Error(`stripe charges list failed: ${res.status}`);
      const json = (await res.json()) as {
        data?: Array<{
          id?: string;
          paid?: boolean;
          refunded?: boolean;
          payment_intent?: string | { id?: string };
        }>;
      };
      const charge = (json.data ?? []).find((row) => row.paid && !row.refunded && row.id);
      if (!charge?.id) return null;
      const paymentIntent =
        typeof charge.payment_intent === 'string'
          ? charge.payment_intent
          : (charge.payment_intent?.id ?? null);
      return { chargeId: charge.id, paymentIntentId: paymentIntent };
    },
    async refundCharge(chargeId) {
      // Full refund of this charge: Stripe refunds the whole amount when
      // `amount` is omitted. Do not add a window or a partial amount here.
      const res = await fetchImpl('https://api.stripe.com/v1/refunds', {
        method: 'POST',
        headers,
        body: new URLSearchParams({ charge: chargeId }).toString(),
      });
      if (!res.ok) throw new Error(`stripe refund failed: ${res.status}`);
      const json = (await res.json()) as { id?: string };
      if (!json.id) throw new Error('stripe refund missing id');
      return { refundId: json.id };
    },
    async cancelSubscription(subscriptionId) {
      const res = await fetchImpl(
        `https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { method: 'DELETE', headers },
      );
      if (!res.ok) throw new Error(`stripe cancel failed: ${res.status}`);
    },
  };
}
