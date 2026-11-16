import { describe, expect, it } from 'vitest';
import {
  foundingPromoOpen,
  isFoundingPriceId,
  paymentLinkUrlWhilePromoAllows,
  plusPriceIdsFromEnv,
  renewalPriceIdForSubscription,
  resolveCheckoutPrice,
} from './prices.js';

const BEFORE = new Date('2026-11-16T12:00:00-05:00');
const AFTER = new Date('2027-01-01T00:00:00-05:00');
const CUTOFF = new Date('2026-12-31T23:59:00-05:00');

const FOUNDING = {
  HOLIDAY_PROMO_ENABLED: 'true',
  STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad',
  STRIPE_PRICE_FOUNDING_ANNUAL_USD: 'price_founding_usd',
};

const WITH_LIST = {
  ...FOUNDING,
  STRIPE_PRICE_PLUS_MONTHLY: 'price_cad_mo',
  STRIPE_PRICE_PLUS_ANNUAL: 'price_cad_yr',
  STRIPE_PRICE_PLUS_MONTHLY_USD: 'price_usd_mo',
  STRIPE_PRICE_PLUS_ANNUAL_USD: 'price_usd_yr',
};

describe('resolveCheckoutPrice', () => {
  it('is unavailable when the holiday flag is off', () => {
    expect(
      resolveCheckoutPrice({
        currency: 'CAD',
        period: 'annual',
        now: BEFORE,
        env: { STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad' },
      }),
    ).toEqual({ status: 'unavailable', reason: 'flag_off' });
  });

  it('selects founding CAD yearly during the window', () => {
    expect(
      resolveCheckoutPrice({ currency: 'CAD', period: 'annual', now: BEFORE, env: FOUNDING }),
    ).toEqual({
      status: 'selected',
      price: {
        priceId: 'price_founding_cad',
        sku: 'founding_annual',
        currency: 'CAD',
        period: 'annual',
      },
    });
  });

  it('selects founding USD yearly during the window even when USD list ids are unset', () => {
    expect(
      resolveCheckoutPrice({ currency: 'USD', period: 'annual', now: BEFORE, env: FOUNDING }),
    ).toEqual({
      status: 'selected',
      price: {
        priceId: 'price_founding_usd',
        sku: 'founding_annual',
        currency: 'USD',
        period: 'annual',
      },
    });
    expect(
      resolveCheckoutPrice({ currency: 'USD', period: 'monthly', now: BEFORE, env: FOUNDING }),
    ).toMatchObject({
      status: 'selected',
      price: { sku: 'founding_annual', priceId: 'price_founding_usd' },
    });
  });

  it('rewrites a monthly or list request during the window to founding yearly', () => {
    expect(
      resolveCheckoutPrice({
        currency: 'USD',
        period: 'monthly',
        now: BEFORE,
        env: WITH_LIST,
      }),
    ).toEqual({
      status: 'selected',
      price: {
        priceId: 'price_founding_usd',
        sku: 'founding_annual',
        currency: 'USD',
        period: 'annual',
      },
    });
    expect(
      resolveCheckoutPrice({
        currency: 'CAD',
        period: 'annual',
        now: BEFORE,
        env: WITH_LIST,
      }),
    ).toMatchObject({ price: { priceId: 'price_founding_cad', sku: 'founding_annual' } });
  });

  it('does not honor period monthly or list annual during the promo when list env ids are set', () => {
    const cadMonthly = resolveCheckoutPrice({
      currency: 'CAD',
      period: 'monthly',
      now: BEFORE,
      env: WITH_LIST,
    });
    const usdMonthly = resolveCheckoutPrice({
      currency: 'USD',
      period: 'monthly',
      now: BEFORE,
      env: WITH_LIST,
    });
    const cadAnnual = resolveCheckoutPrice({
      currency: 'CAD',
      period: 'annual',
      now: BEFORE,
      env: WITH_LIST,
    });
    expect(cadMonthly).toEqual({
      status: 'selected',
      price: {
        priceId: 'price_founding_cad',
        sku: 'founding_annual',
        currency: 'CAD',
        period: 'annual',
      },
    });
    expect(usdMonthly).toEqual({
      status: 'selected',
      price: {
        priceId: 'price_founding_usd',
        sku: 'founding_annual',
        currency: 'USD',
        period: 'annual',
      },
    });
    expect(cadAnnual).toMatchObject({
      price: { priceId: 'price_founding_cad', sku: 'founding_annual', period: 'annual' },
    });
    expect(JSON.stringify([cadMonthly, usdMonthly, cadAnnual])).not.toContain('price_cad_mo');
    expect(JSON.stringify([cadMonthly, usdMonthly, cadAnnual])).not.toContain('price_usd_mo');
    expect(JSON.stringify([cadMonthly, usdMonthly, cadAnnual])).not.toContain('price_cad_yr');
  });

  it('lets a preview caller buy founding while the live flag is off', () => {
    expect(
      resolveCheckoutPrice({
        currency: 'CAD',
        period: 'monthly',
        now: BEFORE,
        preview: true,
        env: {
          STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad',
          STRIPE_PRICE_PLUS_ANNUAL: 'price_cad_yr',
        },
      }),
    ).toEqual({
      status: 'selected',
      price: {
        priceId: 'price_founding_cad',
        sku: 'founding_annual',
        currency: 'CAD',
        period: 'annual',
      },
    });
  });

  it('never serves the Payment Link URL during the window', () => {
    const env = { STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/plus' };
    expect(paymentLinkUrlWhilePromoAllows(BEFORE, env)).toBeNull();
    expect(paymentLinkUrlWhilePromoAllows(AFTER, env)).toBe('https://buy.stripe.com/plus');
  });

  it('stops offering founding after the cutoff and uses list prices instead', () => {
    expect(foundingPromoOpen(CUTOFF, FOUNDING)).toBe(true);
    expect(foundingPromoOpen(new Date('2026-12-31T23:59:59-05:00'), FOUNDING)).toBe(true);
    expect(foundingPromoOpen(AFTER, FOUNDING)).toBe(false);
    expect(
      resolveCheckoutPrice({ currency: 'USD', period: 'annual', now: AFTER, env: WITH_LIST }),
    ).toEqual({
      status: 'selected',
      price: {
        priceId: 'price_usd_yr',
        sku: 'plus_annual',
        currency: 'USD',
        period: 'annual',
      },
    });
    expect(
      resolveCheckoutPrice({ currency: 'CAD', period: 'annual', now: AFTER, env: WITH_LIST }),
    ).toMatchObject({ price: { priceId: 'price_cad_yr', sku: 'plus_annual' } });
    expect(
      resolveCheckoutPrice({ currency: 'USD', period: 'annual', now: AFTER, env: FOUNDING }),
    ).toEqual({ status: 'unavailable', reason: 'no_price' });
  });

  it('does not charge list during the window when the founding id is missing', () => {
    expect(
      resolveCheckoutPrice({
        currency: 'USD',
        period: 'annual',
        now: BEFORE,
        env: {
          HOLIDAY_PROMO_ENABLED: 'true',
          STRIPE_PRICE_PLUS_ANNUAL_USD: 'price_usd_yr',
          STRIPE_PRICE_PLUS_ANNUAL: 'price_cad_yr',
        },
      }),
    ).toEqual({ status: 'unavailable', reason: 'no_price' });
  });

  it('falls back to CAD list when USD list is unset after the window', () => {
    expect(
      resolveCheckoutPrice({
        currency: 'USD',
        period: 'annual',
        now: AFTER,
        env: {
          HOLIDAY_PROMO_ENABLED: 'true',
          STRIPE_PRICE_FOUNDING_ANNUAL_USD: 'price_founding_usd',
          STRIPE_PRICE_PLUS_ANNUAL: 'price_cad_yr',
        },
      }),
    ).toMatchObject({ price: { priceId: 'price_cad_yr', currency: 'CAD' } });
  });
});

describe('founding renewal after the cutoff', () => {
  it('keeps a pre-cutoff founding subscription on the founding price', () => {
    const env = FOUNDING;
    expect(isFoundingPriceId('price_founding_usd', env)).toBe(true);
    expect(renewalPriceIdForSubscription('price_founding_usd', AFTER, env)).toBe(
      'price_founding_usd',
    );
    expect(renewalPriceIdForSubscription('price_founding_cad', AFTER, env)).toBe(
      'price_founding_cad',
    );
    expect(plusPriceIdsFromEnv(env)).toEqual(
      expect.arrayContaining(['price_founding_cad', 'price_founding_usd']),
    );
  });
});
