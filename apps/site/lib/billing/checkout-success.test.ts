import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  type CheckoutSessionFacts,
  billingThreadNoticesEnabled,
  checkoutFactsFromJson,
  checkoutSessionIdFromSearch,
  checkoutSuccessStatesEnabled,
  checkoutViewForPage,
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

describe('checkout success flags', () => {
  it.each([
    ['CHECKOUT_SUCCESS_STATES_ENABLED', checkoutSuccessStatesEnabled],
    ['BILLING_THREAD_NOTICES_ENABLED', billingThreadNoticesEnabled],
  ] as const)('%s is on only for the exact value true', (name, read) => {
    expect(read({})).toBe(false);
    for (const value of ['TRUE', 'true\n', ' true', '1', 'on', '']) {
      expect(read({ [name]: value })).toBe(false);
    }
    expect(read({ [name]: 'true' })).toBe(true);
  });

  it('declares the states flag in the catalog hale-web reads it from', () => {
    const catalog = readFileSync(
      fileURLToPath(new URL('../../../../packages/flags/src/catalog.ts', import.meta.url)),
      'utf8',
    );
    expect(catalog).toContain("env: 'CHECKOUT_SUCCESS_STATES_ENABLED'");
  });
});

describe('checkoutFactsFromJson view', () => {
  const BASE = { transactionId: 'cs_test_1', value: 79, currency: 'CAD', paid: true, tier: 'plus' };

  it('keeps the name and check-in only on the active plan, with the verified plan name', () => {
    expect(
      checkoutFactsFromJson({
        ...BASE,
        view: { state: 'plan_active', firstName: 'Riley', checkInDue: true, familyId: 'x' },
      })?.view,
    ).toEqual({ state: 'plan_active', plan: 'Plus', firstName: 'Riley', checkInDue: true });
    expect(
      checkoutFactsFromJson({ ...BASE, tier: 'family', view: { state: 'plan_active' } })?.view,
    ).toEqual({ state: 'plan_active', plan: 'Max', firstName: null, checkInDue: false });
  });

  it('reads a check-in that is not exactly true as false', () => {
    for (const checkInDue of ['true', 1, null, undefined]) {
      expect(
        checkoutFactsFromJson({ ...BASE, view: { state: 'plan_active', checkInDue } })?.view,
      ).toMatchObject({ checkInDue: false });
    }
  });

  it('drops the name and every other field from any other state', () => {
    for (const state of [
      'upgraded',
      'new_visitor',
      'pending',
      'under_review',
      'receipt',
      'not_paid',
      'unknown',
    ]) {
      expect(
        checkoutFactsFromJson({
          ...BASE,
          view: { state, firstName: 'Riley', checkInDue: true, phone: '+15555550100' },
        })?.view,
      ).toEqual({ state });
    }
    expect(
      checkoutFactsFromJson({
        ...BASE,
        view: { state: 'already_on_plan', firstName: 'Riley' },
      })?.view,
    ).toEqual({ state: 'already_on_plan', plan: 'Plus' });
  });

  it('shows the neutral view when a state that names the plan has no verified plan', () => {
    for (const state of ['plan_active', 'already_on_plan']) {
      expect(
        checkoutFactsFromJson({ ...BASE, tier: null, view: { state, firstName: 'Riley' } })?.view,
      ).toEqual({ state: 'receipt' });
    }
  });

  it('carries no view for an unknown state or a missing one', () => {
    expect(checkoutFactsFromJson({ ...BASE, view: { state: 'surprise' } })).not.toHaveProperty(
      'view',
    );
    expect(checkoutFactsFromJson({ ...BASE, view: 'plan_active' })).not.toHaveProperty('view');
    expect(checkoutFactsFromJson(BASE)).not.toHaveProperty('view');
  });
});

describe('checkoutViewForPage', () => {
  const ON = { CHECKOUT_SUCCESS_STATES_ENABLED: 'true' };
  const FACTS: CheckoutSessionFacts = {
    transactionId: 'cs_test_1',
    value: 79,
    currency: 'CAD',
    paid: true,
    tier: 'plus',
  };

  it('is null with the flag off, whatever the app sent', () => {
    expect(
      checkoutViewForPage('cs_test_1', { ...FACTS, view: { state: 'receipt' } }, {}),
    ).toBeNull();
    expect(checkoutViewForPage(null, null, {})).toBeNull();
  });

  it('is unknown with no session id or a failed read', () => {
    expect(checkoutViewForPage(null, null, ON)).toEqual({ state: 'unknown' });
    expect(checkoutViewForPage('cs_test_1', null, ON)).toEqual({ state: 'unknown' });
  });

  it('is the app view when there is one, and null when the app sent none', () => {
    expect(checkoutViewForPage('cs_test_1', { ...FACTS, view: { state: 'pending' } }, ON)).toEqual({
      state: 'pending',
    });
    expect(checkoutViewForPage('cs_test_1', FACTS, ON)).toBeNull();
  });
});
