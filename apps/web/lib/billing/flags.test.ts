import { describe, expect, it } from 'vitest';
import {
  billingThreadNoticesArmedAt,
  checkoutServerCurrencyEnabled,
  checkoutSuccessStatesEnabled,
  conversionsApiEnabled,
  holidayPromoEnabled,
  metaCapiEnabled,
  promoNewVisitorCheckoutEnabled,
  stripeBillingRevokeEnabled,
  stripeRefundEndsSubscriptionEnabled,
} from './flags.js';

describe('holiday/conversion flags', () => {
  it('are off unless the value is exactly true', () => {
    expect(holidayPromoEnabled({})).toBe(false);
    expect(promoNewVisitorCheckoutEnabled({})).toBe(false);
    expect(conversionsApiEnabled({})).toBe(false);
    expect(metaCapiEnabled({})).toBe(false);
    expect(holidayPromoEnabled({ HOLIDAY_PROMO_ENABLED: 'true\n' })).toBe(false);
    expect(holidayPromoEnabled({ HOLIDAY_PROMO_ENABLED: 'TRUE' })).toBe(false);
    expect(holidayPromoEnabled({ HOLIDAY_PROMO_ENABLED: 'on' })).toBe(false);
    expect(holidayPromoEnabled({ HOLIDAY_PROMO_ENABLED: 'true' })).toBe(true);
    expect(promoNewVisitorCheckoutEnabled({ PROMO_NEW_VISITOR_CHECKOUT_ENABLED: 'TRUE' })).toBe(
      false,
    );
    expect(promoNewVisitorCheckoutEnabled({ PROMO_NEW_VISITOR_CHECKOUT_ENABLED: 'true' })).toBe(
      true,
    );
    expect(conversionsApiEnabled({ CONVERSIONS_API_ENABLED: 'true' })).toBe(true);
    expect(metaCapiEnabled({ META_CAPI_ENABLED: 'true' })).toBe(true);
    expect(checkoutServerCurrencyEnabled({})).toBe(false);
    expect(checkoutServerCurrencyEnabled({ CHECKOUT_SERVER_CURRENCY_ENABLED: 'TRUE' })).toBe(false);
    expect(checkoutServerCurrencyEnabled({ CHECKOUT_SERVER_CURRENCY_ENABLED: 'true\n' })).toBe(
      false,
    );
    expect(checkoutServerCurrencyEnabled({ CHECKOUT_SERVER_CURRENCY_ENABLED: 'true' })).toBe(true);
    expect(stripeBillingRevokeEnabled({})).toBe(false);
    expect(stripeBillingRevokeEnabled({ STRIPE_BILLING_REVOKE_ENABLED: 'on' })).toBe(false);
    expect(stripeBillingRevokeEnabled({ STRIPE_BILLING_REVOKE_ENABLED: 'true' })).toBe(true);
    expect(checkoutSuccessStatesEnabled({})).toBe(false);
    for (const value of ['TRUE', 'true\n', ' true', '1', 'on', '']) {
      expect(checkoutSuccessStatesEnabled({ CHECKOUT_SUCCESS_STATES_ENABLED: value })).toBe(false);
    }
    expect(checkoutSuccessStatesEnabled({ CHECKOUT_SUCCESS_STATES_ENABLED: 'true' })).toBe(true);
  });
});

describe('billingThreadNoticesArmedAt', () => {
  const SINCE = '2026-11-22T15:00:00Z';

  it('is armed only by the exact flag and a strict UTC instant', () => {
    expect(
      billingThreadNoticesArmedAt({
        BILLING_THREAD_NOTICES_ENABLED: 'true',
        BILLING_THREAD_NOTICES_SINCE: SINCE,
      }),
    ).toEqual(new Date(SINCE));
    expect(
      billingThreadNoticesArmedAt({
        BILLING_THREAD_NOTICES_ENABLED: 'true',
        BILLING_THREAD_NOTICES_SINCE: '2026-11-22T15:00:00.250Z',
      }),
    ).toEqual(new Date('2026-11-22T15:00:00.250Z'));
  });

  it.each([
    ['flag unset', undefined, SINCE],
    ['flag with a trailing newline', 'true\n', SINCE],
    ['flag TRUE', 'TRUE', SINCE],
    ['since unset', 'true', undefined],
    ['since a bare date', 'true', '2026-11-22'],
    ['since with a trailing newline', 'true', `${SINCE}\n`],
    ['since with an offset instead of Z', 'true', '2026-11-22T15:00:00+00:00'],
    ['since not a real day', 'true', '2026-02-31T15:00:00Z'],
    ['since garbage', 'true', 'yesterday'],
  ])('stays off with %s', (_label, flag, since) => {
    expect(
      billingThreadNoticesArmedAt({
        BILLING_THREAD_NOTICES_ENABLED: flag,
        BILLING_THREAD_NOTICES_SINCE: since,
      }),
    ).toBeNull();
  });

  it('turns on refund-ends-subscription only for the exact value true', () => {
    const read = (value?: string) =>
      stripeRefundEndsSubscriptionEnabled({ STRIPE_REFUND_ENDS_SUBSCRIPTION_ENABLED: value });
    expect(stripeRefundEndsSubscriptionEnabled({})).toBe(false);
    expect(read('on')).toBe(false);
    expect(read('TRUE')).toBe(false);
    expect(read('true\n')).toBe(false);
    expect(read('true')).toBe(true);
  });
});

describe('billingThreadNoticesArmedAt', () => {
  const SINCE = '2026-11-22T15:00:00Z';

  it('is armed only by the exact flag and a strict UTC instant', () => {
    expect(
      billingThreadNoticesArmedAt({
        BILLING_THREAD_NOTICES_ENABLED: 'true',
        BILLING_THREAD_NOTICES_SINCE: SINCE,
      }),
    ).toEqual(new Date(SINCE));
    expect(
      billingThreadNoticesArmedAt({
        BILLING_THREAD_NOTICES_ENABLED: 'true',
        BILLING_THREAD_NOTICES_SINCE: '2026-11-22T15:00:00.250Z',
      }),
    ).toEqual(new Date('2026-11-22T15:00:00.250Z'));
  });

  it.each([
    ['flag unset', undefined, SINCE],
    ['flag with a trailing newline', 'true\n', SINCE],
    ['flag TRUE', 'TRUE', SINCE],
    ['since unset', 'true', undefined],
    ['since a bare date', 'true', '2026-11-22'],
    ['since with a trailing newline', 'true', `${SINCE}\n`],
    ['since with an offset instead of Z', 'true', '2026-11-22T15:00:00+00:00'],
    ['since not a real day', 'true', '2026-02-31T15:00:00Z'],
    ['since garbage', 'true', 'yesterday'],
  ])('stays off with %s', (_label, flag, since) => {
    expect(
      billingThreadNoticesArmedAt({
        BILLING_THREAD_NOTICES_ENABLED: flag,
        BILLING_THREAD_NOTICES_SINCE: since,
      }),
    ).toBeNull();
  });
});
