import { describe, expect, it, vi } from 'vitest';
import { stripeCheckoutClientFromEnv } from './stripe-client.js';

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
    expect(body.get('customer_email')).toBe('p@example.com');
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
