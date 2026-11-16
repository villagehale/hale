import { afterEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.fn();
const clientMock = { createCheckoutSession: vi.fn() };

vi.mock('~/auth', () => ({
  auth: async () => ({ user: { id: 'auth-1', email: 'p@example.com' } }),
}));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/billing/create-checkout', () => ({
  createBillingCheckout: (...args: unknown[]) => createMock(...args),
}));
vi.mock('~/lib/billing/stripe-client', () => ({
  stripeCheckoutClientFromEnv: () => clientMock,
}));

async function post(body: unknown, headers: Record<string, string> = {}) {
  const { POST } = await import('./route');
  return POST(
    new Request('https://app.example.com/api/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/billing/checkout', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    createMock.mockReset();
  });

  it('404s when HOLIDAY_PROMO_ENABLED is off (the dormant default)', async () => {
    const res = await post({ period: 'annual' });
    expect(res.status).toBe(404);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('selects founding USD for a US visitor during the window and threads UTMs', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('STRIPE_PRICE_FOUNDING_ANNUAL_USD', 'price_founding_usd');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    createMock.mockResolvedValue({
      status: 'created',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
    });

    const res = await post(
      { period: 'annual', gclid: 'Click1', utm_source: 'google' },
      { 'x-vercel-ip-country': 'US', cookie: '_fbp=fb.1.1.cookie' },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(createMock).toHaveBeenCalledTimes(1);
    const arg = createMock.mock.calls[0]?.[0] as {
      priceId: string;
      sku: string;
      currency: string;
      period: string;
      attribution: { gclid?: string; utm_source?: string };
      adsContext?: { fbp?: string; clientIp?: string; clientUserAgent?: string };
    };
    expect(arg.priceId).toBe('price_founding_usd');
    expect(arg.sku).toBe('founding_annual');
    expect(arg.currency).toBe('USD');
    expect(arg.period).toBe('annual');
    expect(arg.attribution).toMatchObject({ gclid: 'Click1', utm_source: 'google' });
    expect(arg.adsContext).toMatchObject({ fbp: 'fb.1.1.cookie' });
  });

  it('selects founding CAD when the geo header is missing', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('STRIPE_PRICE_FOUNDING_ANNUAL_CAD', 'price_founding_cad');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    createMock.mockResolvedValue({
      status: 'created',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
    });

    const res = await post({ period: 'annual' });
    expect(res.status).toBe(200);
    const arg = createMock.mock.calls[0]?.[0] as { priceId: string; currency: string };
    expect(arg.priceId).toBe('price_founding_cad');
    expect(arg.currency).toBe('CAD');
  });

  it('refuses a founding confirmation whose shown currency no longer matches geo', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('STRIPE_PRICE_FOUNDING_ANNUAL_CAD', 'price_founding_cad');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('APP_URL', 'https://app.example.com');

    const res = await post(
      { period: 'annual', offer: 'founding', expectedCurrency: 'CAD' },
      { 'x-vercel-ip-country': 'US' },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'currency_changed' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('never silently falls back to a list price when the founding offer is asked for', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_FOUNDING_ENDS_AT', '2020-01-01T00:00:00Z');
    vi.stubEnv('STRIPE_PRICE_FOUNDING_ANNUAL_CAD', 'price_founding_cad');
    vi.stubEnv('STRIPE_PRICE_PLUS_ANNUAL', 'price_plus_annual_cad');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('APP_URL', 'https://app.example.com');

    const res = await post({ period: 'annual', offer: 'founding', expectedCurrency: 'CAD' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'founding_unavailable' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('409s when the family already has a subscription', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('STRIPE_PRICE_FOUNDING_ANNUAL_CAD', 'price_founding_cad');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    createMock.mockResolvedValue({ status: 'already_paid' });

    const res = await post({ period: 'annual' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_paid' });
  });
});
