import { describe, expect, it } from 'vitest';
import { decidePaidSessionGrant, paidSessionPriceIds } from './session-price-guard';

const BEFORE = new Date('2026-11-16T12:00:00-05:00');
const AFTER = new Date('2027-01-01T00:00:00-05:00');
const ENV = {
  STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad',
  STRIPE_PRICE_FOUNDING_ANNUAL_USD: 'price_founding_usd',
  STRIPE_PRICE_PLUS_MONTHLY: 'price_cad_mo',
  STRIPE_PRICE_PLUS_ANNUAL: 'price_cad_yr',
  STRIPE_PRICE_PLUS_MONTHLY_USD: 'price_usd_mo',
  STRIPE_PRICE_PLUS_ANNUAL_USD: 'price_usd_yr',
  STRIPE_PAYMENT_LINK_ID: 'plink_year',
  STRIPE_PAYMENT_LINK_TIER: 'plus',
};

function checkout(object: Record<string, unknown>) {
  return { id: 'evt_cs', type: 'checkout.session.completed', data: { object } };
}

describe('paidSessionPriceIds', () => {
  it('reads line_items and metadata.priceId', () => {
    expect(
      paidSessionPriceIds({
        metadata: { priceId: 'price_founding_cad' },
        line_items: { data: [{ price: { id: 'price_cad_mo' } }, { price: 'price_usd_mo' }] },
      }),
    ).toEqual(['price_founding_cad', 'price_cad_mo', 'price_usd_mo']);
  });
});

describe('decidePaidSessionGrant', () => {
  it('allows a founding Checkout Session during the window', () => {
    expect(
      decidePaidSessionGrant(
        checkout({
          id: 'cs_founding',
          metadata: { tier: 'plus', priceId: 'price_founding_cad' },
        }),
        BEFORE,
        ENV,
      ),
    ).toEqual({ status: 'allow' });
  });

  it('refuses a list monthly or annual price on a paid session during the window', () => {
    expect(
      decidePaidSessionGrant(
        checkout({
          id: 'cs_mo',
          metadata: { tier: 'plus', priceId: 'price_cad_mo' },
          line_items: { data: [{ price: { id: 'price_cad_mo' } }] },
        }),
        BEFORE,
        ENV,
      ),
    ).toEqual({
      status: 'disallowed',
      priceIds: ['price_cad_mo'],
      reason: 'list_price',
      sessionId: 'cs_mo',
    });
    expect(
      decidePaidSessionGrant(
        checkout({
          id: 'cs_yr',
          metadata: { priceId: 'price_usd_yr' },
        }),
        BEFORE,
        ENV,
      ),
    ).toMatchObject({ status: 'disallowed', reason: 'list_price', priceIds: ['price_usd_yr'] });
  });

  it('refuses a Payment Link completion during the window when no founding price is visible', () => {
    expect(
      decidePaidSessionGrant(
        checkout({
          id: 'cs_plink',
          payment_link: 'plink_year',
          metadata: { tier: 'plus' },
        }),
        BEFORE,
        ENV,
      ),
    ).toEqual({
      status: 'disallowed',
      priceIds: [],
      reason: 'payment_link',
      sessionId: 'cs_plink',
    });
  });

  it('refuses subscription.created on a list price during the window', () => {
    expect(
      decidePaidSessionGrant(
        {
          id: 'evt_sub',
          type: 'customer.subscription.created',
          data: { object: { items: { data: [{ price: { id: 'price_usd_mo' } }] } } },
        },
        BEFORE,
        ENV,
      ),
    ).toEqual({
      status: 'disallowed',
      priceIds: ['price_usd_mo'],
      reason: 'list_price',
      sessionId: null,
    });
  });

  it('allows list prices on a paid session after the cutoff', () => {
    expect(
      decidePaidSessionGrant(
        checkout({
          id: 'cs_list',
          metadata: { tier: 'plus', priceId: 'price_cad_mo' },
          payment_link: 'plink_year',
        }),
        AFTER,
        ENV,
      ),
    ).toEqual({ status: 'allow' });
    expect(
      decidePaidSessionGrant(
        checkout({
          id: 'cs_family',
          metadata: { tier: 'family', priceId: 'price_family_yr' },
        }),
        AFTER,
        { ...ENV, STRIPE_PRICE_FAMILY_ANNUAL: 'price_family_yr' },
      ),
    ).toEqual({ status: 'allow' });
  });

  it('refuses invoice.paid on a new list-price subscription during the window, not a renewal', () => {
    expect(
      decidePaidSessionGrant(
        {
          id: 'evt_inv_new',
          type: 'invoice.paid',
          data: {
            object: {
              id: 'in_new',
              billing_reason: 'subscription_create',
              lines: { data: [{ price: { id: 'price_cad_mo' } }] },
            },
          },
        },
        BEFORE,
        ENV,
      ),
    ).toEqual({
      status: 'disallowed',
      priceIds: ['price_cad_mo'],
      reason: 'list_price',
      sessionId: 'in_new',
    });
    expect(
      decidePaidSessionGrant(
        {
          id: 'evt_inv_cycle',
          type: 'invoice.paid',
          data: {
            object: {
              billing_reason: 'subscription_cycle',
              lines: { data: [{ price: { id: 'price_cad_mo' } }] },
            },
          },
        },
        BEFORE,
        ENV,
      ),
    ).toEqual({ status: 'allow' });
  });
});
