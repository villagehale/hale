import { describe, expect, it } from 'vitest';
import {
  foundingPromoOpen,
  isPromoPriceId,
  paidTierFromUnknown,
  paymentLinkUrlWhilePromoAllows,
  plusPriceIdsFromEnv,
  promoMaxPriceIdsFromEnv,
  promoPriceIdsFromEnv,
  renewalPriceIdForSubscription,
  resolveCheckoutPrice,
} from './prices.js';

const BEFORE = new Date('2026-11-16T12:00:00-05:00');
const AFTER = new Date('2027-01-01T00:00:00-05:00');
const CUTOFF = new Date('2026-12-31T23:59:00-05:00');

const PROMO = {
  HOLIDAY_PROMO_ENABLED: 'true',
  STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD: 'price_plus_cad',
  STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD: 'price_plus_usd',
  STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD: 'price_max_cad',
  STRIPE_PRICE_PROMO_MAX_ANNUAL_USD: 'price_max_usd',
};

const WITH_LIST = {
  ...PROMO,
  STRIPE_PRICE_PLUS_MONTHLY: 'price_cad_mo',
  STRIPE_PRICE_PLUS_ANNUAL: 'price_cad_yr',
  STRIPE_PRICE_PLUS_MONTHLY_USD: 'price_usd_mo',
  STRIPE_PRICE_PLUS_ANNUAL_USD: 'price_usd_yr',
};

describe('paidTierFromUnknown', () => {
  it('maps max to family and everything else to plus', () => {
    expect(paidTierFromUnknown('family')).toBe('family');
    expect(paidTierFromUnknown('max')).toBe('family');
    expect(paidTierFromUnknown('plus')).toBe('plus');
    expect(paidTierFromUnknown(undefined)).toBe('plus');
    expect(paidTierFromUnknown('nope')).toBe('plus');
  });
});

describe('resolveCheckoutPrice', () => {
  it('is unavailable when the holiday flag is off', () => {
    expect(
      resolveCheckoutPrice({
        currency: 'CAD',
        period: 'annual',
        now: BEFORE,
        env: { STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD: 'price_plus_cad' },
      }),
    ).toEqual({ status: 'unavailable', reason: 'flag_off' });
  });

  it('selects Plus CAD yearly during the window', () => {
    expect(
      resolveCheckoutPrice({ currency: 'CAD', period: 'annual', now: BEFORE, env: PROMO }),
    ).toEqual({
      status: 'selected',
      price: {
        priceId: 'price_plus_cad',
        sku: 'promo_plus_annual',
        currency: 'CAD',
        period: 'annual',
      },
    });
  });

  it('selects Max USD yearly during the window', () => {
    expect(
      resolveCheckoutPrice({
        currency: 'USD',
        period: 'monthly',
        now: BEFORE,
        env: PROMO,
        tier: 'family',
      }),
    ).toEqual({
      status: 'selected',
      price: {
        priceId: 'price_max_usd',
        sku: 'promo_max_annual',
        currency: 'USD',
        period: 'annual',
      },
    });
  });

  it('selects Plus USD yearly during the window even when USD list ids are unset', () => {
    expect(
      resolveCheckoutPrice({ currency: 'USD', period: 'annual', now: BEFORE, env: PROMO }),
    ).toEqual({
      status: 'selected',
      price: {
        priceId: 'price_plus_usd',
        sku: 'promo_plus_annual',
        currency: 'USD',
        period: 'annual',
      },
    });
    expect(
      resolveCheckoutPrice({ currency: 'USD', period: 'monthly', now: BEFORE, env: PROMO }),
    ).toMatchObject({
      status: 'selected',
      price: { sku: 'promo_plus_annual', priceId: 'price_plus_usd' },
    });
  });

  it('rewrites a monthly or list request during the window to that tier’s promo yearly', () => {
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
        priceId: 'price_plus_usd',
        sku: 'promo_plus_annual',
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
        tier: 'family',
      }),
    ).toMatchObject({ price: { priceId: 'price_max_cad', sku: 'promo_max_annual' } });
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
        priceId: 'price_plus_cad',
        sku: 'promo_plus_annual',
        currency: 'CAD',
        period: 'annual',
      },
    });
    expect(usdMonthly).toEqual({
      status: 'selected',
      price: {
        priceId: 'price_plus_usd',
        sku: 'promo_plus_annual',
        currency: 'USD',
        period: 'annual',
      },
    });
    expect(cadAnnual).toMatchObject({
      price: { priceId: 'price_plus_cad', sku: 'promo_plus_annual', period: 'annual' },
    });
    expect(JSON.stringify([cadMonthly, usdMonthly, cadAnnual])).not.toContain('price_cad_mo');
    expect(JSON.stringify([cadMonthly, usdMonthly, cadAnnual])).not.toContain('price_usd_mo');
    expect(JSON.stringify([cadMonthly, usdMonthly, cadAnnual])).not.toContain('price_cad_yr');
  });

  it('lets a preview caller buy Plus promo while the live flag is off', () => {
    expect(
      resolveCheckoutPrice({
        currency: 'CAD',
        period: 'monthly',
        now: BEFORE,
        preview: true,
        env: {
          STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD: 'price_plus_cad',
          STRIPE_PRICE_PLUS_ANNUAL: 'price_cad_yr',
        },
      }),
    ).toEqual({
      status: 'selected',
      price: {
        priceId: 'price_plus_cad',
        sku: 'promo_plus_annual',
        currency: 'CAD',
        period: 'annual',
      },
    });
  });

  it('reads leftover STRIPE_PRICE_FOUNDING_ANNUAL_* when the new Plus promo env is unset', () => {
    expect(
      resolveCheckoutPrice({
        currency: 'CAD',
        period: 'annual',
        now: BEFORE,
        env: {
          HOLIDAY_PROMO_ENABLED: 'true',
          STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad',
        },
      }),
    ).toMatchObject({
      price: { priceId: 'price_founding_cad', sku: 'promo_plus_annual' },
    });
  });

  it('never serves the Payment Link URL during the window', () => {
    const env = { STRIPE_PAYMENT_LINK_URL: 'https://buy.stripe.com/plus' };
    expect(paymentLinkUrlWhilePromoAllows(BEFORE, env)).toBeNull();
    expect(paymentLinkUrlWhilePromoAllows(AFTER, env)).toBe('https://buy.stripe.com/plus');
  });

  it('stops offering promo after the cutoff and uses list prices instead', () => {
    expect(foundingPromoOpen(CUTOFF, PROMO)).toBe(true);
    expect(foundingPromoOpen(new Date('2026-12-31T23:59:59-05:00'), PROMO)).toBe(true);
    expect(foundingPromoOpen(AFTER, PROMO)).toBe(false);
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
      resolveCheckoutPrice({ currency: 'USD', period: 'annual', now: AFTER, env: PROMO }),
    ).toEqual({ status: 'unavailable', reason: 'no_price' });
  });

  it('does not charge list during the window when the promo id is missing', () => {
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
    expect(
      resolveCheckoutPrice({
        currency: 'CAD',
        period: 'annual',
        now: BEFORE,
        tier: 'family',
        env: {
          HOLIDAY_PROMO_ENABLED: 'true',
          STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD: 'price_plus_cad',
          STRIPE_PRICE_FAMILY_ANNUAL: 'price_family_yr',
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
          STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD: 'price_plus_usd',
          STRIPE_PRICE_PLUS_ANNUAL: 'price_cad_yr',
        },
      }),
    ).toMatchObject({ price: { priceId: 'price_cad_yr', currency: 'CAD' } });
  });
});

describe('promo renewal after the cutoff', () => {
  it('keeps a pre-cutoff promo subscription on the promo price', () => {
    const env = PROMO;
    expect(isPromoPriceId('price_plus_usd', env)).toBe(true);
    expect(isPromoPriceId('price_max_cad', env)).toBe(true);
    expect(renewalPriceIdForSubscription('price_plus_usd', AFTER, env)).toBe('price_plus_usd');
    expect(renewalPriceIdForSubscription('price_max_cad', AFTER, env)).toBe('price_max_cad');
    expect(plusPriceIdsFromEnv(env)).toEqual(
      expect.arrayContaining(['price_plus_cad', 'price_plus_usd']),
    );
    expect(plusPriceIdsFromEnv(env)).not.toContain('price_max_cad');
    expect(promoMaxPriceIdsFromEnv(env)).toEqual(
      expect.arrayContaining(['price_max_cad', 'price_max_usd']),
    );
    expect(promoPriceIdsFromEnv(env)).toHaveLength(4);
  });
});
