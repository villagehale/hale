import { describe, expect, it, vi } from 'vitest';
import { integrationIdentifier, stripeCheckoutClientFromEnv } from './stripe-client.js';

/**
 * The client posts a subscription Checkout Session to Stripe with an injected fetch
 * (no live call). The critical contract: the session metadata carries tier + priceId
 * and the family id (client_reference_id + metadata + subscription_data.metadata) —
 * that's what the webhook reads back, since Stripe sends no line_items on the event.
 */

describe('stripeCheckoutClientFromEnv', () => {
  it('returns null when STRIPE_SECRET_KEY is absent (dormant)', () => {
    expect(stripeCheckoutClientFromEnv({})).toBeNull();
  });

  it('posts a subscription session threading tier + priceId + family into metadata', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), {
        status: 200,
      }),
    );
    const client = stripeCheckoutClientFromEnv({ STRIPE_SECRET_KEY: 'sk_test' }, fetchMock);
    if (!client) throw new Error('expected a configured client');

    const result = await client.createCheckoutSession({
      priceId: 'price_plus_annual',
      familyId: 'fam-7',
      tier: 'plus',
      period: 'annual',
      successUrl: 'https://app.example.com/settings?checkout=success#billing',
      cancelUrl: 'https://app.example.com/settings?checkout=cancelled#billing',
      customerEmail: 'p@example.com',
      sku: 'promo_plus_annual',
      currency: 'CAD',
      attribution: { utm_source: 'google', gclid: 'Click1' },
      adsContext: {
        fbp: 'fb.1.1.cookie',
        clientIp: '203.0.113.9',
        clientUserAgent: 'Mozilla/5.0 HaleTest',
      },
    });

    expect(result).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk_test');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('mode')).toBe('subscription');
    expect(body.get('line_items[0][price]')).toBe('price_plus_annual');
    expect(body.get('client_reference_id')).toBe('fam-7');
    expect(body.get('metadata[familyId]')).toBe('fam-7');
    expect(body.get('metadata[tier]')).toBe('plus');
    expect(body.get('metadata[priceId]')).toBe('price_plus_annual');
    expect(body.get('subscription_data[metadata][familyId]')).toBe('fam-7');
    expect(body.get('subscription_data[metadata][tier]')).toBe('plus');
    expect(body.get('metadata[sku]')).toBe('promo_plus_annual');
    expect(body.get('subscription_data[metadata][sku]')).toBe('promo_plus_annual');
    expect(body.get('metadata[currency]')).toBe('CAD');
    expect(body.get('metadata[utm_source]')).toBe('google');
    expect(body.get('metadata[gclid]')).toBe('Click1');
    expect(body.get('subscription_data[metadata][gclid]')).toBe('Click1');
    expect(body.get('metadata[fbp]')).toBe('fb.1.1.cookie');
    expect(body.get('metadata[client_ip]')).toBe('203.0.113.9');
    expect(body.get('metadata[client_ua]')).toBe('Mozilla/5.0 HaleTest');
    expect(body.has('subscription_data[metadata][fbp]')).toBe(false);
    expect(body.has('subscription_data[metadata][client_ip]')).toBe(false);
    expect(body.get('customer_email')).toBe('p@example.com');
    expect(body.get('integration_identifier')).toBe(integrationIdentifier('fam-7'));
    expect(body.get('integration_identifier')).toMatch(/^hale-checkout-[a-z]{8}$/);
    expect(body.has('payment_method_types')).toBe(false);
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeUndefined();
  });

  it('keeps the dashboard identifier stable for the same family', () => {
    expect(integrationIdentifier('fam-7')).toBe(integrationIdentifier('fam-7'));
    expect(integrationIdentifier('fam-7')).not.toBe(integrationIdentifier('fam-8'));
  });

  it('sends customer and Idempotency-Key instead of a second email when reusing a Customer', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_1' }), {
        status: 200,
      }),
    );
    const client = stripeCheckoutClientFromEnv({ STRIPE_SECRET_KEY: 'sk_test' }, fetchMock);
    if (!client) throw new Error('expected a configured client');

    await client.createCheckoutSession({
      priceId: 'price_founding',
      familyId: 'fam-7',
      tier: 'plus',
      period: 'annual',
      successUrl: 'https://www.villagehale.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://app.example.com/founding?checkout=cancelled',
      customerId: 'cus_existing',
      customerEmail: 'p@example.com',
      idempotencyKey: 'hale-checkout-fam-7',
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBe(
      'hale-checkout-fam-7',
    );
    const body = new URLSearchParams(init.body as string);
    expect(body.get('customer')).toBe('cus_existing');
    expect(body.has('customer_email')).toBe(false);
  });

  it('retrieves a Checkout Session by id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'cs_test_1',
          payment_status: 'paid',
          amount_total: 7900,
          currency: 'cad',
        }),
        { status: 200 },
      ),
    );
    const client = stripeCheckoutClientFromEnv({ STRIPE_SECRET_KEY: 'sk_test' }, fetchMock);
    if (!client?.retrieveCheckoutSession) throw new Error('expected retrieve');
    const session = await client.retrieveCheckoutSession('cs_test_1');
    expect(session).toMatchObject({ id: 'cs_test_1', amount_total: 7900, currency: 'cad' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.stripe.com/v1/checkout/sessions/cs_test_1',
    );
  });

  it('asks Stripe to expand only what the caller names on a retrieve', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(JSON.stringify({ id: 'cs_test_1' })));
    const client = stripeCheckoutClientFromEnv({ STRIPE_SECRET_KEY: 'sk_test' }, fetchMock);
    if (!client?.retrieveCheckoutSession) throw new Error('expected retrieve');

    await client.retrieveCheckoutSession('cs_test_1');
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'https://api.stripe.com/v1/checkout/sessions/cs_test_1',
    );

    await client.retrieveCheckoutSession('cs_test_1', { expand: ['subscription'] });
    const url = new URL(String(fetchMock.mock.calls[1]?.[0]));
    expect(`${url.origin}${url.pathname}`).toBe(
      'https://api.stripe.com/v1/checkout/sessions/cs_test_1',
    );
    expect(url.searchParams.getAll('expand[]')).toEqual(['subscription']);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'GET' });
  });

  it('throws (never returns a broken url) when Stripe responds non-2xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('nope', { status: 400 }));
    const client = stripeCheckoutClientFromEnv({ STRIPE_SECRET_KEY: 'sk_test' }, fetchMock);
    if (!client) throw new Error('expected a configured client');

    await expect(
      client.createCheckoutSession({
        priceId: 'price_x',
        familyId: 'fam-7',
        tier: 'plus',
        period: 'monthly',
        successUrl: 's',
        cancelUrl: 'c',
      }),
    ).rejects.toThrow(/stripe checkout session create failed/);
  });
});
