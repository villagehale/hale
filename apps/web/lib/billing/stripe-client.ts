import { createHash } from 'node:crypto';
import type { Attribution, BillingCurrency, BillingPeriod } from '@hale/types';
import type { PaidTier } from '~/lib/webhooks/stripe-billing';
import type { AdsCheckoutContext } from './ads-context.js';
import { adsContextToStripeMetadata } from './ads-context.js';
import { attributionToStripeMetadata } from './attribution.js';
import type { CheckoutSku } from './prices.js';

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
  /** Reuses an existing Stripe Customer so a family cannot mint a second one. */
  readonly customerId?: string | null;
  /**
   * Optional Stripe Idempotency-Key for retrying the same request. Not a
   * lifetime lock: Checkout bodies include ads IP/UA, so a family-wide key
   * rejects a later legitimate session. Duplicate live subscriptions are
   * blocked by plan_tier + reused Stripe Customer.
   */
  readonly idempotencyKey?: string;
  readonly sku?: CheckoutSku;
  readonly currency?: BillingCurrency;
  readonly attribution?: Attribution;
  readonly adsContext?: AdsCheckoutContext;
}

export interface StripeCheckoutClient {
  createCheckoutSession(params: CheckoutSessionParams): Promise<{ url: string }>;
  retrieveCheckoutSession?(sessionId: string): Promise<unknown | null>;
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
      const headers: Record<string, string> = {
        authorization: `Bearer ${secret}`,
        'content-type': 'application/x-www-form-urlencoded',
      };
      if (params.idempotencyKey) {
        headers['Idempotency-Key'] = params.idempotencyKey;
      }
      const res = await fetchImpl(STRIPE_CHECKOUT_ENDPOINT, {
        method: 'POST',
        headers,
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
    async retrieveCheckoutSession(sessionId) {
      const res = await fetchImpl(`${STRIPE_CHECKOUT_ENDPOINT}/${sessionId}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${secret}` },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        throw new Error(`stripe checkout session retrieve failed: ${res.status}`);
      }
      return res.json();
    },
  };
}

/**
 * The form-encoded body for a subscription Checkout Session.
 *
 * Family id is threaded as client_reference_id AND metadata on BOTH the session and
 * the subscription, so every downstream event resolves its family. Tier + price id
 * go in the SESSION metadata because Stripe does not send line_items/price on the
 * checkout.session.completed webhook — the handler grants from metadata.tier, so we
 * must put the tier we're selling there. The subscription itself carries the real
 * price (items.data[0].price.id), so subscription.* events map from that, not metadata.
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
    'metadata[tier]': params.tier,
    'metadata[priceId]': params.priceId,
    'subscription_data[metadata][familyId]': params.familyId,
    'subscription_data[metadata][tier]': params.tier,
    integration_identifier: integrationIdentifier(params.familyId),
  });
  if (params.sku) {
    form.set('metadata[sku]', params.sku);
    form.set('subscription_data[metadata][sku]', params.sku);
  }
  if (params.currency) {
    form.set('metadata[currency]', params.currency);
    form.set('subscription_data[metadata][currency]', params.currency);
  }
  const attribution = params.attribution ? attributionToStripeMetadata(params.attribution) : {};
  for (const [key, value] of Object.entries(attribution)) {
    form.set(`metadata[${key}]`, value);
    form.set(`subscription_data[metadata][${key}]`, value);
  }
  const ads = params.adsContext ? adsContextToStripeMetadata(params.adsContext) : {};
  for (const [key, value] of Object.entries(ads)) {
    form.set(`metadata[${key}]`, value);
  }
  if (params.customerId) {
    form.set('customer', params.customerId);
  } else if (params.customerEmail) {
    form.set('customer_email', params.customerEmail);
  }
  return form;
}

/**
 * Dashboard label. The 8-letter suffix is what Stripe asks for on this field.
 * Derived from the family so two calls with the same params stay identical.
 */
export function integrationIdentifier(familyId: string): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  const digest = createHash('sha256').update(familyId).digest();
  let suffix = '';
  for (let i = 0; i < 8; i++) suffix += alphabet[(digest[i] ?? 0) % 26];
  return `hale-checkout-${suffix}`;
}
