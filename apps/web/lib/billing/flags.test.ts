import { describe, expect, it } from 'vitest';
import {
  checkoutServerCurrencyEnabled,
  conversionsApiEnabled,
  holidayPromoEnabled,
  metaCapiEnabled,
  promoNewVisitorCheckoutEnabled,
  stripeBillingRevokeEnabled,
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
  });
});
