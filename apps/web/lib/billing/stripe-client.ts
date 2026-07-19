import type { BillingPeriod } from '@hale/types';
import type { PaidTier } from '~/lib/webhooks/stripe-billing';

/**
 * Minimal Stripe Checkout client, behind an interface so the route is testable
 * without a live Stripe call (inject a fake in tests; a real fetch in prod). Only
 * the one call billing needs — create a subscription Checkout Session — is modelled.
 * Absent STRIPE_SECRET_KEY the factory returns null (the route 501s), so this is
 * inert until keys arrive.
 */

export interface CheckoutSessionParams {
  readonly priceId: string;
  readonly familyId: string;
  readonly tier: PaidTier;
  readonly period: BillingPeriod;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** Prefills the Stripe-hosted form; safe to omit. */
  readonly customerEmail?: string | null;
}

export interface StripeCheckoutClient {
  createCheckoutSession(params: CheckoutSessionParams): Promise<{ url: string }>;
}

const STRIPE_CHECKOUT_ENDPOINT = 'https://api.stripe.com/v1/checkout/sessions';

/**
 * Builds a client from env, or null when STRIPE_SECRET_KEY is absent. `fetchImpl`
 * is injectable for tests; prod uses the global fetch.
 */
export function stripeCheckoutClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): StripeCheckoutClient | null {
  const secret = env.STRIPE_SECRET_KEY;
  if (!secret) return null;
  return {
    async createCheckoutSession(params) {
      const form = checkoutForm(params);
      const res = await fetchImpl(STRIPE_CHECKOUT_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secret}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
      });
      if (!res.ok) {
        throw new Error(`stripe checkout session create failed: ${res.status}`);
      }
      const json = (await res.json()) as { url?: unknown };
      if (typeof json.url !== 'string' || json.url.length === 0) {
        throw new Error('stripe checkout session response missing url');
      }
      return { url: json.url };
    },
  };
}

/**
 * The form-encoded body for a subscription Checkout Session. The family id is
 * threaded as client_reference_id AND metadata (session + subscription) so every
 * downstream billing event carries it back for family resolution.
 */
function checkoutForm(params: CheckoutSessionParams): URLSearchParams {
  const form = new URLSearchParams({
    mode: 'subscription',
    'line_items[0][price]': params.priceId,
    'line_items[0][quantity]': '1',
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    client_reference_id: params.familyId,
    'metadata[familyId]': params.familyId,
    'subscription_data[metadata][familyId]': params.familyId,
  });
  if (params.customerEmail) {
    form.set('customer_email', params.customerEmail);
  }
  return form;
}
