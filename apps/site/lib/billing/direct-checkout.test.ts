import { PROMO_PRICE_DISPLAY } from '@hale/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../../app/api/checkout/route';
import { directCheckoutForm, selectDirectCheckoutPrice } from './direct-checkout';

const NOW = new Date('2026-11-25T18:00:00.000Z');
const AFTER = new Date('2027-01-02T05:00:00.000Z');

const PROMO = {
  HOLIDAY_PROMO_ENABLED: 'true',
  CHECKOUT_SERVER_CURRENCY_ENABLED: 'true',
  STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD: 'price_plus_cad',
  STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD: 'price_plus_usd',
  STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD: 'price_max_cad',
  STRIPE_PRICE_PROMO_MAX_ANNUAL_USD: 'price_max_usd',
  STRIPE_PRICE_PLUS_ANNUAL: 'price_plus_list_cad',
  STRIPE_PRICE_PLUS_ANNUAL_USD: 'price_plus_list_usd',
  STRIPE_PRICE_MAX_ANNUAL_CAD: 'price_max_list_cad',
  STRIPE_PRICE_MAX_ANNUAL_USD: 'price_max_list_usd',
};

describe('direct checkout price', () => {
  it('charges the promo price id for CA and US, Plus and Max, and keeps display amounts beside it', () => {
    expect(PROMO_PRICE_DISPLAY.plus.CAD.amount).toBe(59);
    expect(PROMO_PRICE_DISPLAY.family.CAD.amount).toBe(99);
    expect(PROMO_PRICE_DISPLAY.plus.USD.amount).toBe(39);
    expect(PROMO_PRICE_DISPLAY.family.USD.amount).toBe(79);
    expect(
      selectDirectCheckoutPrice({ tier: 'plus', currency: 'CAD', now: NOW, env: PROMO }),
    ).toMatchObject({
      priceId: 'price_plus_cad',
      sku: 'promo_plus_annual',
      tier: 'plus',
      currency: 'CAD',
    });
    expect(
      selectDirectCheckoutPrice({ tier: 'family', currency: 'CAD', now: NOW, env: PROMO }),
    ).toMatchObject({
      priceId: 'price_max_cad',
      sku: 'promo_max_annual',
    });
    expect(
      selectDirectCheckoutPrice({ tier: 'plus', currency: 'USD', now: NOW, env: PROMO }),
    ).toMatchObject({
      priceId: 'price_plus_usd',
      sku: 'promo_plus_annual',
    });
    expect(
      selectDirectCheckoutPrice({ tier: 'family', currency: 'USD', now: NOW, env: PROMO }),
    ).toMatchObject({
      priceId: 'price_max_usd',
      sku: 'promo_max_annual',
      tier: 'family',
    });
  });

  it('refuses a missing promo id instead of charging the list price', () => {
    const env = { ...PROMO, STRIPE_PRICE_PROMO_MAX_ANNUAL_USD: '' };
    expect(
      selectDirectCheckoutPrice({ tier: 'family', currency: 'USD', now: NOW, env }).status,
    ).toBe('unavailable');
  });

  it('uses list ids after the window, and stays dark when the promo flag is off', () => {
    expect(
      selectDirectCheckoutPrice({ tier: 'plus', currency: 'USD', now: AFTER, env: PROMO }),
    ).toMatchObject({
      priceId: 'price_plus_list_usd',
      sku: 'plus_annual',
    });
    expect(
      selectDirectCheckoutPrice({ tier: 'family', currency: 'CAD', now: AFTER, env: PROMO }),
    ).toMatchObject({
      priceId: 'price_max_list_cad',
      sku: 'max_annual',
    });
    expect(
      selectDirectCheckoutPrice({
        tier: 'plus',
        currency: 'CAD',
        now: NOW,
        env: { ...PROMO, HOLIDAY_PROMO_ENABLED: 'false' },
      }),
    ).toEqual({ status: 'unavailable', reason: 'flag_off' });
  });

  it('asks Stripe for a required phone, card and Link, and no family', () => {
    const form = directCheckoutForm({
      priceId: 'price_plus_cad',
      tier: 'plus',
      sku: 'promo_plus_annual',
      currency: 'CAD',
      successUrl: 'https://www.villagehale.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://www.villagehale.com/pricing?checkout=cancelled',
      attribution: { gclid: 'click' },
    });
    expect(form.get('phone_number_collection[enabled]')).toBe('true');
    expect(form.get('payment_method_types[0]')).toBe('card');
    expect(form.get('payment_method_types[1]')).toBe('link');
    expect(form.get('metadata[source]')).toBe('pricing_direct');
    expect(form.get('metadata[tier]')).toBe('plus');
    expect(form.get('metadata[currency]')).toBe('CAD');
    expect(form.get('metadata[gclid]')).toBe('click');
    expect(form.get('subscription_data[metadata][source]')).toBe('pricing_direct');
    expect(form.get('client_reference_id')).toBeNull();
    expect(form.get('metadata[familyId]')).toBeNull();
    expect(form.get('success_url')).toContain('/checkout/success?session_id={CHECKOUT_SESSION_ID}');
    expect(form.get('cancel_url')).toContain('/pricing?checkout=cancelled');
  });

  it('puts msclkid on the session always, and source_code plus the consented id only with the funnel flag', () => {
    const shared = {
      priceId: 'price_plus_cad',
      tier: 'plus' as const,
      sku: 'promo_plus_annual' as const,
      currency: 'CAD' as const,
      successUrl: 'https://www.villagehale.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl: 'https://www.villagehale.com/pricing?checkout=cancelled',
      attribution: { msclkid: 'msclk', source_code: 'poster-oakville', gclid: 'click' },
      analyticsDistinctId: '0123456789abcdef',
    };
    const dark = directCheckoutForm({ ...shared, env: {} });
    expect(dark.get('metadata[msclkid]')).toBe('msclk');
    expect(dark.get('subscription_data[metadata][msclkid]')).toBe('msclk');
    expect(dark.get('metadata[source_code]')).toBeNull();
    expect(dark.get('metadata[ph_distinct_id]')).toBeNull();

    const lit = directCheckoutForm({ ...shared, env: { FUNNEL_ATTRIBUTION_ENABLED: 'true' } });
    expect(lit.get('metadata[msclkid]')).toBe('msclk');
    expect(lit.get('metadata[source_code]')).toBe('poster-oakville');
    expect(lit.get('subscription_data[metadata][source_code]')).toBe('poster-oakville');
    expect(lit.get('metadata[ph_distinct_id]')).toBe('0123456789abcdef');
    expect(lit.get('subscription_data[metadata][ph_distinct_id]')).toBeNull();

    const email = directCheckoutForm({
      ...shared,
      analyticsDistinctId: 'parent@example.com',
      env: { FUNNEL_ATTRIBUTION_ENABLED: 'true' },
    });
    expect(email.get('metadata[ph_distinct_id]')).toBeNull();
  });
});

describe('GET /api/checkout', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    for (const [key, value] of Object.entries(PROMO)) vi.stubEnv(key, value);
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_example');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function request(tier: string, country?: string, extra?: Record<string, string>) {
    const headers = new Headers(extra);
    if (country) headers.set('x-vercel-ip-country', country);
    return new Request(`https://preview.villagehale.com/api/checkout?tier=${tier}&gclid=click`, {
      headers,
    });
  }

  it('redirects CA Plus and US Max at the promo price, with a required phone and no family', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(String(init.body));
        return new Response(
          JSON.stringify({ url: 'https://checkout.stripe.com/c/pay/cs_test_abc' }),
          {
            status: 200,
          },
        );
      }),
    );
    const ca = await GET(request('plus', 'CA'));
    expect(ca.status).toBe(303);
    expect(ca.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_abc');
    const plus = new URLSearchParams(bodies[0]);
    expect(plus.get('line_items[0][price]')).toBe('price_plus_cad');
    expect(plus.get('metadata[tier]')).toBe('plus');
    expect(plus.get('metadata[source]')).toBe('pricing_direct');
    expect(plus.get('phone_number_collection[enabled]')).toBe('true');
    expect(plus.get('payment_method_types[0]')).toBe('card');
    expect(plus.get('payment_method_types[1]')).toBe('link');
    expect(plus.get('metadata[familyId]')).toBeNull();
    expect(plus.get('client_reference_id')).toBeNull();
    expect(plus.get('metadata[gclid]')).toBe('click');
    expect(plus.get('success_url')).toBe(
      'https://preview.villagehale.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
    );
    expect(plus.get('cancel_url')).toBe(
      'https://preview.villagehale.com/pricing?checkout=cancelled',
    );

    const us = await GET(request('max', 'US'));
    expect(us.status).toBe(303);
    const max = new URLSearchParams(bodies[1]);
    expect(max.get('line_items[0][price]')).toBe('price_max_usd');
    expect(max.get('metadata[tier]')).toBe('family');
    expect(max.get('metadata[currency]')).toBe('USD');
  });

  it('does not mint a session for a prefetch, a country outside US and CA, or a missing price', async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal('fetch', fetchImpl);
    const prefetch = await GET(request('plus', 'CA', { purpose: 'prefetch' }));
    expect(prefetch.status).toBe(204);
    const outside = await GET(request('plus', 'MX'));
    expect(outside.status).toBe(403);
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD', '');
    const missing = await GET(request('plus', 'CA'));
    expect(missing.status).toBe(501);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes source_code and msclkid into Stripe metadata and records checkout_started on the session', async () => {
    vi.stubEnv('FUNNEL_ATTRIBUTION_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'ph_test_key');
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: String(init.body) });
        if (String(url).includes('api.stripe.com')) {
          return new Response(
            JSON.stringify({
              id: 'cs_test_attr',
              url: 'https://checkout.stripe.com/c/pay/cs_test_attr',
            }),
            { status: 200 },
          );
        }
        return new Response('ok', { status: 200 });
      }),
    );
    const headers = new Headers({ 'x-vercel-ip-country': 'CA' });
    const res = await GET(
      new Request(
        'https://preview.villagehale.com/api/checkout?tier=plus&msclkid=msclk&source_code=poster-oakville&ph_distinct_id=0123456789abcdef',
        { headers },
      ),
    );
    expect(res.status).toBe(303);
    const stripe = calls.find((call) => call.url.includes('api.stripe.com'));
    const form = new URLSearchParams(stripe?.body);
    expect(form.get('metadata[msclkid]')).toBe('msclk');
    expect(form.get('metadata[source_code]')).toBe('poster-oakville');
    expect(form.get('metadata[ph_distinct_id]')).toBe('0123456789abcdef');
    const captures = calls
      .filter((call) => call.url.includes('/capture/'))
      .map(
        (call) =>
          JSON.parse(call.body) as {
            event?: string;
            distinct_id?: string;
            properties?: Record<string, unknown>;
          },
      );
    const started = captures.find((call) => call.event === 'checkout_started');
    const alias = captures.find((call) => call.event === '$create_alias');
    expect(started?.distinct_id).toBe('cs:cs_test_attr');
    expect(started?.properties).toMatchObject({
      sku: 'promo_plus_annual',
      currency: 'CAD',
      msclkid: 'msclk',
      source_code: 'poster-oakville',
    });
    expect(JSON.stringify(started)).not.toContain('ph_distinct_id');
    expect(JSON.stringify(started)).not.toContain('@');
    expect(alias?.distinct_id).toBe('0123456789abcdef');
    expect(alias?.properties).toMatchObject({ alias: 'cs:cs_test_attr' });
  });

  it('stores fbp and fbc on the session and sends InitiateCheckout with that session id', async () => {
    vi.stubEnv('META_CAPI_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_META_PIXEL_ID', '2041301346827688');
    vi.stubEnv('META_CAPI_ACCESS_TOKEN', 'token');
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body) });
        if (String(url).includes('api.stripe.com')) {
          return new Response(
            JSON.stringify({
              id: 'cs_test_ads',
              url: 'https://checkout.stripe.com/c/pay/cs_test_ads',
              amount_total: 5900,
              currency: 'cad',
            }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 200 });
      }),
    );
    const headers = new Headers({
      'x-vercel-ip-country': 'CA',
      'x-hale-checkout': 'json',
      cookie: '_fbp=fb.1.1.cookie; _fbc=fb.1.9.fromcookie',
      'user-agent': 'Mozilla/5.0 HaleTest',
      'x-forwarded-for': '203.0.113.9',
    });
    const res = await GET(
      new Request('https://preview.villagehale.com/api/checkout?tier=plus&fbclid=ClickFace', {
        headers,
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: 'https://checkout.stripe.com/c/pay/cs_test_ads',
      sessionId: 'cs_test_ads',
      value: 59,
      currency: 'CAD',
    });
    const stripe = new URLSearchParams(
      calls.find((call) => call.url.includes('api.stripe.com'))?.body,
    );
    expect(stripe.get('metadata[fbp]')).toBe('fb.1.1.cookie');
    expect(stripe.get('metadata[fbc]')).toBe('fb.1.9.fromcookie');
    expect(stripe.get('metadata[fbclid]')).toBe('ClickFace');
    expect(stripe.get('metadata[client_ip]')).toBe('203.0.113.9');
    expect(stripe.get('subscription_data[metadata][fbp]')).toBeNull();
    expect(stripe.get('subscription_data[metadata][fbc]')).toBeNull();
    const capi = calls.find((call) => call.url.includes('graph.facebook.com'));
    const body = JSON.parse(capi?.body ?? '{}') as {
      data: Array<{
        event_name: string;
        event_id: string;
        user_data: Record<string, string>;
        custom_data: { value: number; currency: string };
      }>;
    };
    expect(body.data[0]).toMatchObject({
      event_name: 'InitiateCheckout',
      event_id: 'cs_test_ads',
      custom_data: { value: 59, currency: 'CAD' },
      user_data: {
        fbp: 'fb.1.1.cookie',
        fbc: 'fb.1.9.fromcookie',
        client_ip_address: '203.0.113.9',
        client_user_agent: 'Mozilla/5.0 HaleTest',
      },
    });
    expect(JSON.stringify(body)).not.toContain('@');
    expect(body.data[0]?.user_data).not.toHaveProperty('em');
  });

  it('builds fbc from fbclid when the click cookie is missing', async () => {
    vi.stubEnv('META_CAPI_ENABLED', 'true');
    vi.stubEnv('NEXT_PUBLIC_META_PIXEL_ID', '2041301346827688');
    vi.stubEnv('META_CAPI_ACCESS_TOKEN', 'token');
    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), body: String(init?.body) });
        if (String(url).includes('api.stripe.com')) {
          return new Response(
            JSON.stringify({
              id: 'cs_test_fbclid',
              url: 'https://checkout.stripe.com/c/pay/cs_test_fbclid',
              amount_total: 3900,
              currency: 'usd',
            }),
            { status: 200 },
          );
        }
        return new Response('{}', { status: 200 });
      }),
    );
    const res = await GET(
      new Request('https://preview.villagehale.com/api/checkout?tier=plus&fbclid=ClickFace', {
        headers: { 'x-vercel-ip-country': 'US' },
      }),
    );
    expect(res.status).toBe(303);
    const stripe = new URLSearchParams(
      calls.find((call) => call.url.includes('api.stripe.com'))?.body,
    );
    expect(stripe.get('metadata[fbc]')).toMatch(/^fb\.1\.\d+\.ClickFace$/);
    expect(stripe.get('metadata[fbp]')).toBeNull();
    const capi = JSON.parse(
      calls.find((call) => call.url.includes('graph.facebook.com'))?.body ?? '{}',
    ) as {
      data: Array<{
        event_id: string;
        custom_data: { currency: string; value: number };
        user_data: { fbc: string };
      }>;
    };
    expect(capi.data[0]?.event_id).toBe('cs_test_fbclid');
    expect(capi.data[0]?.custom_data).toEqual({ currency: 'USD', value: 39 });
    expect(capi.data[0]?.user_data.fbc).toBe(stripe.get('metadata[fbc]'));
  });
});
