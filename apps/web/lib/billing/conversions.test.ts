import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  eventsReceivedFromMetaJson,
  hashEmailForAds,
  hashPhoneForAds,
  metaCapiPurchaseBody,
  metaTestEventCodeFromEnv,
  purchaseFromStripeEvent,
  reportBillingPurchase,
  sendMetaPurchase,
  sendMetaTestPurchase,
} from './conversions.js';

function checkoutPaid(overrides: Record<string, unknown> = {}) {
  return {
    id: 'evt_pay_1',
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_1',
        payment_status: 'paid',
        amount_total: 7900,
        currency: 'cad',
        payment_intent: 'pi_1',
        customer_details: { email: 'Sam@Example.com', phone: '+1 (416) 555-0100' },
        metadata: {
          familyId: 'fam-1',
          sku: 'founding_annual',
          utm_source: 'google',
          gclid: 'Click1',
          fbp: 'fb.1.1.cookie',
          fbc: 'fb.1.1.click',
          client_ip: '203.0.113.9',
          client_ua: 'Mozilla/5.0 HaleTest',
        },
        client_reference_id: 'fam-1',
        ...overrides,
      },
    },
  };
}

describe('purchaseFromStripeEvent', () => {
  it('uses the Checkout Session id as event_id and reads Stripe amount, phone, and ads context', () => {
    const purchase = purchaseFromStripeEvent(checkoutPaid());
    expect(purchase).toMatchObject({
      eventId: 'cs_1',
      orderId: 'cs_1',
      value: 79,
      currency: 'CAD',
      email: 'Sam@Example.com',
      phone: '+1 (416) 555-0100',
      familyId: 'fam-1',
      sku: 'founding_annual',
      attribution: { utm_source: 'google', gclid: 'Click1' },
      ads: {
        fbp: 'fb.1.1.cookie',
        fbc: 'fb.1.1.click',
        clientIp: '203.0.113.9',
        clientUserAgent: 'Mozilla/5.0 HaleTest',
      },
    });
  });

  it('reads USD 59 from amount_total', () => {
    expect(
      purchaseFromStripeEvent(checkoutPaid({ amount_total: 5900, currency: 'usd' })),
    ).toMatchObject({ value: 59, currency: 'USD' });
  });

  it('ignores invoice.paid renewals and unpaid sessions', () => {
    expect(
      purchaseFromStripeEvent({ id: 'evt_inv', type: 'invoice.paid', data: { object: {} } }),
    ).toBeNull();
    expect(purchaseFromStripeEvent(checkoutPaid({ payment_status: 'unpaid' }))).toBeNull();
  });
});

describe('hashers', () => {
  it('hashes email as SHA-256 of the trimmed lowercase address', () => {
    expect(hashEmailForAds('Sam@Example.com')).toBe(
      createHash('sha256').update('sam@example.com').digest('hex'),
    );
  });

  it('hashes phone as SHA-256 of digits-only NANP E.164', () => {
    expect(hashPhoneForAds('+1 (416) 555-0100')).toBe(
      createHash('sha256').update('14165550100').digest('hex'),
    );
    expect(hashPhoneForAds('416-555-0100')).toBe(
      createHash('sha256').update('14165550100').digest('hex'),
    );
  });
});

describe('senders no-op without flags or env', () => {
  const purchase = purchaseFromStripeEvent(checkoutPaid());
  if (!purchase) throw new Error('expected a purchase');

  it('Meta skips flag_off, then not_configured without a token, and never fetches', async () => {
    const fetchImpl = vi.fn();
    expect(await sendMetaPurchase(purchase, {}, fetchImpl)).toEqual({
      status: 'skipped',
      reason: 'flag_off',
    });
    expect(
      await sendMetaPurchase(
        purchase,
        { META_CAPI_ENABLED: 'true', NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766' },
        fetchImpl,
      ),
    ).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends Meta CAPI with the Checkout Session event_id, hashed PII, and matching cookies', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const result = await sendMetaPurchase(
      purchase,
      {
        META_CAPI_ENABLED: 'true',
        NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766',
        META_CAPI_ACCESS_TOKEN: 'token-1',
      },
      fetchImpl,
    );
    expect(result).toEqual({ status: 'sent' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/1460101092968766/events?access_token=token-1');
    const body = JSON.parse(init.body as string) as {
      data: Array<{
        event_name: string;
        event_id: string;
        user_data: {
          em: string[];
          ph: string[];
          fbp: string;
          fbc: string;
          client_ip_address: string;
          client_user_agent: string;
        };
        custom_data: { value: number; currency: string };
      }>;
    };
    expect(body.data[0]?.event_name).toBe('Purchase');
    expect(body.data[0]?.event_id).toBe('cs_1');
    expect(body.data[0]?.custom_data).toMatchObject({ value: 79, currency: 'CAD' });
    expect(body.data[0]?.user_data.em).toEqual([hashEmailForAds('Sam@Example.com')]);
    expect(body.data[0]?.user_data.ph).toEqual([hashPhoneForAds('+1 (416) 555-0100')]);
    expect(body.data[0]?.user_data.fbp).toBe('fb.1.1.cookie');
    expect(body.data[0]?.user_data.fbc).toBe('fb.1.1.click');
    expect(body.data[0]?.user_data.client_ip_address).toBe('203.0.113.9');
    expect(body.data[0]?.user_data.client_user_agent).toBe('Mozilla/5.0 HaleTest');
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('Sam@Example.com');
    expect(serialized).not.toContain('416');
    expect(serialized).not.toContain('child');
    expect(body).not.toHaveProperty('test_event_code');
  });

  it('skips preview-family purchases unless META_CAPI_TEST_EVENT_CODE is set', async () => {
    const fetchImpl = vi.fn();
    expect(
      await sendMetaPurchase(
        purchase,
        {
          META_CAPI_ENABLED: 'true',
          NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766',
          META_CAPI_ACCESS_TOKEN: 'token-1',
          PROMO_PREVIEW_FAMILY_IDS: 'fam-1',
        },
        fetchImpl,
      ),
    ).toEqual({ status: 'skipped', reason: 'preview' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends a preview-family purchase when the test event code is set, even if CAPI is off', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const result = await sendMetaPurchase(
      purchase,
      {
        NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766',
        META_CAPI_ACCESS_TOKEN: 'token-1',
        PROMO_PREVIEW_FAMILY_IDS: 'fam-1',
        META_CAPI_TEST_EVENT_CODE: 'TEST12345',
      },
      fetchImpl,
    );
    expect(result).toEqual({ status: 'sent' });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('adds test_event_code when META_CAPI_TEST_EVENT_CODE is set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    await sendMetaPurchase(
      purchase,
      {
        META_CAPI_ENABLED: 'true',
        NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766',
        META_CAPI_ACCESS_TOKEN: 'token-1',
        META_CAPI_TEST_EVENT_CODE: ' TEST12345 ',
      },
      fetchImpl,
    );
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { test_event_code?: string };
    expect(body.test_event_code).toBe('TEST12345');
  });
});

describe('Meta Test Events ops probe', () => {
  it('reads a trimmed test event code and omits it when unset', () => {
    expect(metaTestEventCodeFromEnv({})).toBeNull();
    expect(metaTestEventCodeFromEnv({ META_CAPI_TEST_EVENT_CODE: '  ' })).toBeNull();
    expect(metaTestEventCodeFromEnv({ META_CAPI_TEST_EVENT_CODE: 'TEST12345' })).toBe('TEST12345');
    expect(eventsReceivedFromMetaJson({ events_received: 1 })).toBe(1);
    expect(eventsReceivedFromMetaJson({})).toBeNull();
  });

  it('skips without pixel, token, or test code, and never fetches', async () => {
    const fetchImpl = vi.fn();
    expect(await sendMetaTestPurchase({}, fetchImpl)).toEqual({
      status: 'skipped',
      reason: 'not_configured',
    });
    expect(
      await sendMetaTestPurchase(
        {
          NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766',
          META_CAPI_ACCESS_TOKEN: 'token-1',
        },
        fetchImpl,
      ),
    ).toEqual({ status: 'skipped', reason: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends a hashed fake Purchase with test_event_code and returns status plus events_received', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ events_received: 1 }), { status: 200 }));
    const result = await sendMetaTestPurchase(
      {
        NEXT_PUBLIC_META_PIXEL_ID: '1460101092968766',
        META_CAPI_ACCESS_TOKEN: 'token-1',
        META_CAPI_TEST_EVENT_CODE: 'TEST12345',
      },
      fetchImpl,
    );
    expect(result).toEqual({ status: 200, events_received: 1 });
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      test_event_code?: string;
      data: Array<{ event_id: string; user_data: { em: string[]; ph: string[] } }>;
    };
    expect(body.test_event_code).toBe('TEST12345');
    expect(body.data[0]?.event_id).toBe('cs_test_ops');
    expect(body.data[0]?.user_data.em).toEqual([hashEmailForAds('capi.test@example.com')]);
    expect(JSON.stringify(body)).not.toContain('capi.test@example.com');
    expect(JSON.stringify(body)).not.toContain('+1 555 010 0100');
  });

  it('does not put test_event_code on a live payload when the env is empty', () => {
    const purchase = purchaseFromStripeEvent(checkoutPaid());
    if (!purchase) throw new Error('expected a purchase');
    expect(metaCapiPurchaseBody(purchase, {})).not.toHaveProperty('test_event_code');
  });
});

describe('reportBillingPurchase idempotency seam', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns not_a_purchase for a redelivered invoice so callers can skip', async () => {
    const result = await reportBillingPurchase({
      id: 'evt_inv',
      type: 'invoice.paid',
      data: { object: { amount_paid: 7900, currency: 'cad' } },
    });
    expect(result).toEqual({ status: 'skipped', reason: 'not_a_purchase' });
  });
});
