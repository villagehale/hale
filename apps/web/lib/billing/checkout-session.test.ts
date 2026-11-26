import { describe, expect, it } from 'vitest';
import { MARKETING_SITE_URL } from '~/lib/legal-links';
import {
  CHECKOUT_SESSION_ID_PLACEHOLDER,
  checkoutMarketingOrigin,
  checkoutSessionIdFromUnknown,
  checkoutSuccessUrl,
  paidCheckoutFactsFromStripeSession,
} from './checkout-session.js';

describe('checkoutSessionIdFromUnknown', () => {
  it('accepts a Stripe Checkout Session id and rejects anything else', () => {
    expect(checkoutSessionIdFromUnknown('cs_test_abc123')).toBe('cs_test_abc123');
    expect(checkoutSessionIdFromUnknown('cs_live_AbC_9')).toBe('cs_live_AbC_9');
    expect(checkoutSessionIdFromUnknown(['cs_test_abc123'])).toBe('cs_test_abc123');
    expect(checkoutSessionIdFromUnknown('pi_1')).toBeNull();
    expect(checkoutSessionIdFromUnknown('cs_test_abc 123')).toBeNull();
    expect(checkoutSessionIdFromUnknown('')).toBeNull();
  });
});

describe('paidCheckoutFactsFromStripeSession', () => {
  it('reads amount, currency, and verified tier from the session, never extra fields', () => {
    expect(
      paidCheckoutFactsFromStripeSession({
        id: 'cs_test_cad',
        payment_status: 'paid',
        amount_total: 5900,
        currency: 'cad',
        amount_subtotal: 1,
        metadata: { tier: 'plus' },
      }),
    ).toEqual({
      transactionId: 'cs_test_cad',
      value: 59,
      currency: 'CAD',
      paid: true,
      tier: 'plus',
    });
    expect(
      paidCheckoutFactsFromStripeSession({
        id: 'cs_test_usd',
        payment_status: 'paid',
        amount_total: 7900,
        currency: 'usd',
        metadata: { tier: 'max' },
      }),
    ).toMatchObject({ value: 79, currency: 'USD', paid: true, tier: 'family' });
    expect(
      paidCheckoutFactsFromStripeSession({
        id: 'cs_test_max_cad',
        payment_status: 'paid',
        amount_total: 9900,
        currency: 'cad',
        metadata: { tier: 'family' },
      }),
    ).toMatchObject({ value: 99, currency: 'CAD', tier: 'family' });
  });

  it('marks unpaid sessions so the success page will not fire', () => {
    expect(
      paidCheckoutFactsFromStripeSession({
        id: 'cs_test_unpaid',
        payment_status: 'unpaid',
        amount_total: 5900,
        currency: 'cad',
      }),
    ).toMatchObject({ paid: false, value: 59, currency: 'CAD', tier: null });
  });

  it('marks a pricing_direct session and leaves the phone out of the facts', () => {
    const facts = paidCheckoutFactsFromStripeSession({
      id: 'cs_test_direct',
      payment_status: 'paid',
      amount_total: 5900,
      currency: 'cad',
      customer_details: { phone: '+14165550100', email: 'buyer@example.test' },
      metadata: { source: 'pricing_direct', tier: 'plus' },
    });
    expect(facts).toEqual({
      transactionId: 'cs_test_direct',
      value: 59,
      currency: 'CAD',
      paid: true,
      tier: 'plus',
      direct: true,
    });
    expect(JSON.stringify(facts)).not.toContain('+1416');
    expect(JSON.stringify(facts)).not.toContain('buyer@');
  });
});

describe('checkoutSuccessUrl', () => {
  it('puts Stripe’s session placeholder on the marketing success page', () => {
    expect(checkoutSuccessUrl('https://www.villagehale.com')).toBe(
      `https://www.villagehale.com/checkout/success?session_id=${CHECKOUT_SESSION_ID_PLACEHOLDER}`,
    );
  });
});

describe('checkoutMarketingOrigin', () => {
  it('uses www in production and an override for local/preview', () => {
    expect(checkoutMarketingOrigin(MARKETING_SITE_URL, {})).toBe(MARKETING_SITE_URL);
    expect(
      checkoutMarketingOrigin(MARKETING_SITE_URL, {
        NEXT_PUBLIC_MARKETING_URL: 'https://villagehale.com',
      }),
    ).toBe(MARKETING_SITE_URL);
    expect(
      checkoutMarketingOrigin(MARKETING_SITE_URL, {
        NEXT_PUBLIC_MARKETING_URL: 'http://localhost:3001',
      }),
    ).toBe('http://localhost:3001');
  });
});
