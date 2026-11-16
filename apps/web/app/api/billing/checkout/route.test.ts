import { afterEach, describe, expect, it, vi } from 'vitest';

const createMock = vi.fn();
const resolveFamilyMock = vi.fn();
const clientMock = { createCheckoutSession: vi.fn() };

vi.mock('~/auth', () => ({
  auth: async () => ({ user: { id: 'auth-1', email: 'p@example.com' } }),
}));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...args: unknown[]) => resolveFamilyMock(...args),
}));
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
    resolveFamilyMock.mockReset();
  });

  it('404s when HOLIDAY_PROMO_ENABLED is off (the dormant default)', async () => {
    const res = await post({ period: 'annual' });
    expect(res.status).toBe(404);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('selects Plus promo USD for a US visitor during the window and threads UTMs', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD', 'price_plus_usd');
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
    expect(arg.priceId).toBe('price_plus_usd');
    expect(arg.sku).toBe('promo_plus_annual');
    expect(arg.currency).toBe('USD');
    expect(arg.period).toBe('annual');
    expect(arg.attribution).toMatchObject({ gclid: 'Click1', utm_source: 'google' });
    expect(arg.adsContext).toMatchObject({ fbp: 'fb.1.1.cookie' });
  });

  it('selects Plus promo CAD when the geo header is missing', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD', 'price_plus_cad');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    createMock.mockResolvedValue({
      status: 'created',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
    });

    const res = await post({ period: 'annual' });
    expect(res.status).toBe(200);
    const arg = createMock.mock.calls[0]?.[0] as { priceId: string; currency: string };
    expect(arg.priceId).toBe('price_plus_cad');
    expect(arg.currency).toBe('CAD');
  });

  it('refuses a promo confirmation whose shown currency no longer matches geo', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD', 'price_plus_cad');
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

  it('never silently falls back to a list price when the promo offer is asked for', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_FOUNDING_ENDS_AT', '2020-01-01T00:00:00Z');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD', 'price_plus_cad');
    vi.stubEnv('STRIPE_PRICE_PLUS_ANNUAL', 'price_plus_annual_cad');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('APP_URL', 'https://app.example.com');

    const res = await post({ period: 'annual', offer: 'founding', expectedCurrency: 'CAD' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'founding_unavailable' });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('rewrites a monthly list request during the window to Plus promo annual', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD', 'price_plus_cad');
    vi.stubEnv('STRIPE_PRICE_PLUS_MONTHLY', 'price_cad_mo');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    createMock.mockResolvedValue({
      status: 'created',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
    });

    const res = await post({ period: 'monthly', priceId: 'price_cad_mo', tier: 'plus' });
    expect(res.status).toBe(200);
    const arg = createMock.mock.calls[0]?.[0] as { priceId: string; sku: string; period: string };
    expect(arg.priceId).toBe('price_plus_cad');
    expect(arg.sku).toBe('promo_plus_annual');
    expect(arg.period).toBe('annual');
  });

  it('cannot start a monthly or list-price checkout from a crafted POST while the promo is active', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD', 'price_plus_cad');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD', 'price_plus_usd');
    vi.stubEnv('STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD', 'price_max_cad');
    vi.stubEnv('STRIPE_PRICE_PROMO_MAX_ANNUAL_USD', 'price_max_usd');
    vi.stubEnv('STRIPE_PRICE_PLUS_MONTHLY', 'price_cad_mo');
    vi.stubEnv('STRIPE_PRICE_PLUS_MONTHLY_USD', 'price_usd_mo');
    vi.stubEnv('STRIPE_PRICE_PLUS_ANNUAL', 'price_cad_yr');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    createMock.mockResolvedValue({
      status: 'created',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
    });

    const cadMonthly = await post({
      period: 'monthly',
      priceId: 'price_cad_mo',
      sku: 'plus_monthly',
      tier: 'plus',
    });
    expect(cadMonthly.status).toBe(200);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      priceId: 'price_plus_cad',
      sku: 'promo_plus_annual',
      period: 'annual',
    });

    const usdMonthly = await post(
      { period: 'monthly', priceId: 'price_usd_mo', sku: 'plus_monthly' },
      { 'x-vercel-ip-country': 'US' },
    );
    expect(usdMonthly.status).toBe(200);
    expect(createMock.mock.calls[1]?.[0]).toMatchObject({
      priceId: 'price_plus_usd',
      sku: 'promo_plus_annual',
      period: 'annual',
    });

    const cadAnnual = await post({ period: 'annual', priceId: 'price_cad_yr', sku: 'plus_annual' });
    expect(cadAnnual.status).toBe(200);
    expect(createMock.mock.calls[2]?.[0]).toMatchObject({
      priceId: 'price_plus_cad',
      sku: 'promo_plus_annual',
    });

    const maxCad = await post({ period: 'annual', tier: 'max' });
    expect(maxCad.status).toBe(200);
    expect(createMock.mock.calls[3]?.[0]).toMatchObject({
      priceId: 'price_max_cad',
      sku: 'promo_max_annual',
      tier: 'family',
    });
  });

  it('lets list prices through after the cutoff', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_FOUNDING_ENDS_AT', '2020-01-01T00:00:00Z');
    vi.stubEnv('STRIPE_PRICE_PLUS_ANNUAL', 'price_cad_yr');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    createMock.mockResolvedValue({
      status: 'created',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
    });

    const res = await post({ period: 'annual' });
    expect(res.status).toBe(200);
    const arg = createMock.mock.calls[0]?.[0] as { priceId: string; sku: string };
    expect(arg.priceId).toBe('price_cad_yr');
    expect(arg.sku).toBe('plus_annual');
  });

  it('404s when the flag is off and the family is not listed', async () => {
    resolveFamilyMock.mockResolvedValue('fam-other');
    vi.stubEnv('PROMO_PREVIEW_FAMILY_IDS', 'fam-preview');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD', 'price_plus_cad');
    const res = await post({ period: 'annual' });
    expect(res.status).toBe(404);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('opens Plus promo checkout for a listed preview family while the flag is off', async () => {
    resolveFamilyMock.mockResolvedValue('fam-preview');
    vi.stubEnv('PROMO_PREVIEW_FAMILY_IDS', 'fam-preview');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD', 'price_plus_cad');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    createMock.mockResolvedValue({
      status: 'created',
      url: 'https://checkout.stripe.com/c/pay/cs_1',
    });

    const res = await post({ period: 'monthly' });
    expect(res.status).toBe(200);
    const arg = createMock.mock.calls[0]?.[0] as { priceId: string; sku: string };
    expect(arg.priceId).toBe('price_plus_cad');
    expect(arg.sku).toBe('promo_plus_annual');
  });

  it('409s when the family already has a subscription', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD', 'price_plus_cad');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    createMock.mockResolvedValue({ status: 'already_paid' });

    const res = await post({ period: 'annual' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_paid' });
  });
});
