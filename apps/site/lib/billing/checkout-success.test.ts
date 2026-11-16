import { describe, expect, it, vi } from 'vitest';
import {
  checkoutSessionIdFromSearch,
  conversionsApiEnabled,
  fetchCheckoutSessionFacts,
  googleAdsConversionSendTo,
  googlePurchaseFromPaidSession,
  metaPixelIdFromEnv,
  metaPurchaseFromPaidSession,
} from './checkout-success.js';

const PAID = {
  transactionId: 'cs_test_1',
  value: 79,
  currency: 'CAD',
  paid: true,
  tier: 'family' as const,
};

describe('checkoutSessionIdFromSearch', () => {
  it('reads only session_id, never value or currency from the query', () => {
    expect(
      checkoutSessionIdFromSearch({
        session_id: 'cs_test_1',
        value: '1',
        currency: 'USD',
      }),
    ).toBe('cs_test_1');
    expect(checkoutSessionIdFromSearch({ value: '79', currency: 'CAD' })).toBeNull();
  });
});

describe('googlePurchaseFromPaidSession', () => {
  it('is null unless the flag, send_to, and a paid session are all present', () => {
    expect(
      googlePurchaseFromPaidSession({
        facts: PAID,
        conversionsEnabled: false,
        sendTo: 'AW-18412881223/O_6XCJWSnbkdEMeK-ctE',
      }),
    ).toBeNull();
    expect(
      googlePurchaseFromPaidSession({
        facts: PAID,
        conversionsEnabled: true,
        sendTo: null,
      }),
    ).toBeNull();
    expect(
      googlePurchaseFromPaidSession({
        facts: { ...PAID, paid: false },
        conversionsEnabled: true,
        sendTo: 'AW-18412881223/O_6XCJWSnbkdEMeK-ctE',
      }),
    ).toBeNull();
    expect(
      googlePurchaseFromPaidSession({
        facts: PAID,
        conversionsEnabled: true,
        sendTo: 'AW-18412881223/O_6XCJWSnbkdEMeK-ctE',
      }),
    ).toEqual({
      sendTo: 'AW-18412881223/O_6XCJWSnbkdEMeK-ctE',
      value: 79,
      currency: 'CAD',
      transactionId: 'cs_test_1',
    });
    expect(
      metaPurchaseFromPaidSession({
        facts: PAID,
        conversionsEnabled: true,
        pixelId: '1460101092968766',
      }),
    ).toEqual({
      pixelId: '1460101092968766',
      value: 79,
      currency: 'CAD',
      transactionId: 'cs_test_1',
    });
    expect(
      metaPurchaseFromPaidSession({
        facts: { ...PAID, paid: false },
        conversionsEnabled: true,
        pixelId: '1460101092968766',
      }),
    ).toBeNull();
  });
});

describe('conversions flag and send_to', () => {
  it('are off unless exact true / a non-empty public send_to', () => {
    expect(conversionsApiEnabled({})).toBe(false);
    expect(conversionsApiEnabled({ CONVERSIONS_API_ENABLED: 'TRUE' })).toBe(false);
    expect(conversionsApiEnabled({ CONVERSIONS_API_ENABLED: 'true' })).toBe(true);
    expect(googleAdsConversionSendTo({})).toBeNull();
    expect(
      googleAdsConversionSendTo({
        NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_SEND_TO: 'AW-18412881223/O_6XCJWSnbkdEMeK-ctE',
      }),
    ).toBe('AW-18412881223/O_6XCJWSnbkdEMeK-ctE');
    expect(metaPixelIdFromEnv({})).toBeNull();
    expect(metaPixelIdFromEnv({ NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766' })).toBe(
      '1460101092968766',
    );
  });
});

describe('fetchCheckoutSessionFacts', () => {
  it('asks the app for Stripe facts by session id', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(PAID), { status: 200 }));
    await expect(
      fetchCheckoutSessionFacts('cs_test_1', 'https://app.villagehale.com', fetchImpl),
    ).resolves.toEqual(PAID);
    // An unknown tier from the app reads as null, never a guess.
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ ...PAID, tier: 'max' }), { status: 200 }),
    );
    await expect(
      fetchCheckoutSessionFacts('cs_test_1', 'https://app.villagehale.com', fetchImpl),
    ).resolves.toEqual({ ...PAID, tier: null });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      'https://app.villagehale.com/api/billing/checkout-session?session_id=cs_test_1',
    );
  });
});
