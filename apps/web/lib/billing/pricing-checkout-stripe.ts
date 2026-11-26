import { type DirectCheckoutSnapshot, snapshotFromStripeSession } from './pricing-checkout.js';

const SESSION_ID = /^cs_[A-Za-z0-9_]+$/;
const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9_]+$/;
const FAMILY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read a Checkout Session back from Stripe. customer_details (and its phone)
 * is on the session by default. The body is parsed and dropped — never logged.
 */
export async function retrievePricingCheckoutSnapshot(
  sessionId: string,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DirectCheckoutSnapshot | null> {
  if (!SESSION_ID.test(sessionId)) return null;
  const res = await fetchImpl(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${secret}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`stripe checkout session retrieve failed: ${res.status}`);
  }
  return snapshotFromStripeSession(await res.json());
}

/**
 * Later invoices resolve a family from subscription metadata. A failed patch
 * does not undo the bind; the caller catches it.
 */
export async function annotatePricingSubscription(
  secret: string,
  subscriptionId: string,
  familyId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!SUBSCRIPTION_ID.test(subscriptionId) || !FAMILY_ID.test(familyId)) return;
  const body = new URLSearchParams();
  body.set('metadata[familyId]', familyId);
  const res = await fetchImpl(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${secret}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`stripe subscription annotate failed: ${res.status}`);
  }
}

/**
 * Cancel the new subscription when the number already has a different one.
 * A missing secret is named. The body is never logged. Tests pass fetch.
 */
export async function cancelPricingSubscription(
  secret: string,
  subscriptionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'canceled' | 'not_configured' | 'failed'> {
  if (!secret.trim()) {
    console.warn(
      { event: 'pricing_checkout_cancel_skipped', reason: 'not_configured' },
      'pricing checkout',
    );
    return 'not_configured';
  }
  if (!SUBSCRIPTION_ID.test(subscriptionId)) return 'failed';
  const res = await fetchImpl(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${secret}` },
  });
  if (!res.ok) {
    console.warn(
      { event: 'pricing_checkout_cancel_failed', status: res.status },
      'pricing checkout',
    );
    return 'failed';
  }
  console.info({ event: 'pricing_checkout_cancel' }, 'pricing checkout');
  return 'canceled';
}
