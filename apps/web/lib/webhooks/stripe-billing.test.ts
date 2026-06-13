import { describe, expect, it } from 'vitest';
import {
  planTierFromStripeEvent,
  priceTierMapFromEnv,
  verifyStripeBillingSignature,
  type PriceTierMap,
} from './stripe-billing.js';

/**
 * Fixtures hand-built from Stripe's documented event shapes and the B18 mapping
 * contract (never copied from runtime output):
 *   checkout.session.completed     → tier of the purchased price
 *   customer.subscription.updated  → tier of the active price after the change
 *   customer.subscription.deleted  → 'free'
 *   (anything else)                → null
 */

const PRICE_PLUS = 'price_plus_test';
const PRICE_FAMILY = 'price_family_test';
const MAP: PriceTierMap = { [PRICE_PLUS]: 'plus', [PRICE_FAMILY]: 'family' };

function subscriptionEvent(type: string, priceId: string) {
  return {
    type,
    data: { object: { items: { data: [{ price: { id: priceId } }] } } },
  };
}

function checkoutCompleted(priceId: string) {
  return {
    type: 'checkout.session.completed',
    data: { object: { price: { id: priceId } } },
  };
}

describe('planTierFromStripeEvent', () => {
  it('maps a Plus checkout completion to the plus tier', () => {
    expect(planTierFromStripeEvent(checkoutCompleted(PRICE_PLUS), MAP)).toBe('plus');
  });

  it('maps a Family checkout completion to the family tier', () => {
    expect(planTierFromStripeEvent(checkoutCompleted(PRICE_FAMILY), MAP)).toBe('family');
  });

  it('maps a subscription update to the new price tier', () => {
    const upgrade = subscriptionEvent('customer.subscription.updated', PRICE_FAMILY);
    expect(planTierFromStripeEvent(upgrade, MAP)).toBe('family');
  });

  it('maps a subscription deletion to free (downgrade)', () => {
    const cancel = { type: 'customer.subscription.deleted', data: { object: {} } };
    expect(planTierFromStripeEvent(cancel, MAP)).toBe('free');
  });

  it('returns null for an unrelated event type', () => {
    const unrelated = subscriptionEvent('invoice.payment_succeeded', PRICE_PLUS);
    expect(planTierFromStripeEvent(unrelated, MAP)).toBeNull();
  });

  it('returns null (never silently grants a tier) for an unknown price id', () => {
    const unknownPrice = subscriptionEvent('customer.subscription.updated', 'price_unmapped');
    expect(planTierFromStripeEvent(unknownPrice, MAP)).toBeNull();
  });

  it('returns null for a malformed / non-object payload', () => {
    expect(planTierFromStripeEvent(null, MAP)).toBeNull();
    expect(planTierFromStripeEvent('not-json', MAP)).toBeNull();
    expect(planTierFromStripeEvent({ type: 'checkout.session.completed' }, MAP)).toBeNull();
  });
});

describe('priceTierMapFromEnv', () => {
  it('builds the map only from the price ids that are present', () => {
    expect(priceTierMapFromEnv({ STRIPE_PRICE_PLUS: 'p1' })).toEqual({
      p1: 'plus',
    });
    expect(
      priceTierMapFromEnv({
        STRIPE_PRICE_PLUS: 'p1',
        STRIPE_PRICE_FAMILY: 'f1',
      }),
    ).toEqual({ p1: 'plus', f1: 'family' });
    expect(priceTierMapFromEnv({})).toEqual({});
  });
});

describe('verifyStripeBillingSignature', () => {
  it('refuses to process (not_configured) when STRIPE_WEBHOOK_SECRET is absent', () => {
    const result = verifyStripeBillingSignature('v1=sig', 'body', undefined);
    expect(result.status).toBe('not_configured');
  });

  it('reports invalid when configured but the signature header is missing', () => {
    const result = verifyStripeBillingSignature(null, 'body', 'whsec_test');
    expect(result.status).toBe('invalid');
  });

  it('does not yet return verified even when configured (live wiring pending)', () => {
    const result = verifyStripeBillingSignature('v1=sig', 'body', 'whsec_test');
    expect(result.status).not.toBe('verified');
  });
});
