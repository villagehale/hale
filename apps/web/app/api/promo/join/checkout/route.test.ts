import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROMO_JOIN_COOKIE, signPromoJoinBinding } from '~/lib/billing/promo-join-cookie';
import { PROMO_PREVIEW_COOKIE, signPromoPreviewCookie } from '~/lib/billing/promo-preview';

const createMock = vi.fn();
const clientMock = { createCheckoutSession: vi.fn() };

vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/billing/create-checkout', () => ({
  createBillingCheckout: (...args: unknown[]) => createMock(...args),
}));
vi.mock('~/lib/billing/stripe-client', () => ({
  stripeCheckoutClientFromEnv: () => clientMock,
}));

async function post(
  cookie?: string,
  country = 'CA',
  url = 'https://app.example.com/api/promo/join/checkout',
  body: unknown = {},
) {
  const { POST } = await import('./route');
  return POST(
    new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie } : {}),
        'x-vercel-ip-country': country,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/promo/join/checkout', () => {
  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    createMock.mockReset();
  });

  it('404s when the new-visitor flag is off', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    const res = await post();
    expect(res.status).toBe(404);
  });

  it('401s without a join cookie', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', 'true');
    const res = await post();
    expect(res.status).toBe(401);
  });

  it('404s with a wrong preview token while flags stay off', async () => {
    vi.stubEnv('PROMO_PREVIEW_TOKEN', 'secret');
    const res = await post(
      undefined,
      'CA',
      'https://app.example.com/api/promo/join/checkout?preview=nope',
    );
    expect(res.status).toBe(404);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('opens founding checkout with the preview cookie and never puts ?preview= on cancel', async () => {
    vi.stubEnv('PROMO_PREVIEW_TOKEN', 'secret');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD', 'price_plus_cad');
    const join = signPromoJoinBinding({
      familyId: 'fam-9',
      userId: 'user-9',
      externalAuthId: 'sms:abc',
    });
    const preview = signPromoPreviewCookie({
      AUTH_SECRET: 'test-secret',
      PROMO_PREVIEW_TOKEN: 'secret',
    });
    createMock.mockResolvedValue({
      status: 'created',
      url: 'https://checkout.stripe.com/c/pay/cs',
    });

    const res = await post(
      `${PROMO_JOIN_COOKIE}=${join}; ${PROMO_PREVIEW_COOKIE}=${preview}`,
      'CA',
      'https://app.example.com/api/promo/join/checkout',
    );
    expect(res.status).toBe(200);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      sku: 'promo_plus_annual',
      cancelUrl: 'https://app.example.com/founding?checkout=cancelled',
    });
    expect(String(createMock.mock.calls[0]?.[0].cancelUrl)).not.toContain('preview=');
  });

  it('opens founding checkout with a matching preview token while flags stay off', async () => {
    vi.stubEnv('PROMO_PREVIEW_TOKEN', 'secret');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD', 'price_plus_cad');
    const token = signPromoJoinBinding({
      familyId: 'fam-9',
      userId: 'user-9',
      externalAuthId: 'sms:abc',
    });
    createMock.mockResolvedValue({
      status: 'created',
      url: 'https://checkout.stripe.com/c/pay/cs',
    });

    const res = await post(
      `${PROMO_JOIN_COOKIE}=${token}`,
      'CA',
      'https://app.example.com/api/promo/join/checkout?preview=secret',
    );
    expect(res.status).toBe(200);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({ sku: 'promo_plus_annual' });
  });

  it('opens Checkout for the bound family and 409s on a second subscription', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', 'true');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD', 'price_plus_cad');
    const token = signPromoJoinBinding({
      familyId: 'fam-9',
      userId: 'user-9',
      externalAuthId: 'sms:abc',
    });
    createMock.mockResolvedValue({
      status: 'created',
      url: 'https://checkout.stripe.com/c/pay/cs',
    });

    const res = await post(
      `${PROMO_JOIN_COOKIE}=${token}`,
      'CA',
      'https://app.example.com/api/promo/join/checkout?gclid=Click1&utm_source=google',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs' });
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      familyId: 'fam-9',
      externalAuthId: 'sms:abc',
      cancelUrl: 'https://app.example.com/founding?checkout=cancelled',
      sku: 'promo_plus_annual',
      attribution: { gclid: 'Click1', utm_source: 'google' },
    });

    createMock.mockResolvedValue({ status: 'already_paid' });
    const paid = await post(`${PROMO_JOIN_COOKIE}=${token}`);
    expect(paid.status).toBe(409);
  });

  it('opens Max promo checkout when the body asks for max', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', 'true');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD', 'price_plus_cad');
    vi.stubEnv('STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD', 'price_max_cad');
    const token = signPromoJoinBinding({
      familyId: 'fam-9',
      userId: 'user-9',
      externalAuthId: 'sms:abc',
    });
    createMock.mockResolvedValue({
      status: 'created',
      url: 'https://checkout.stripe.com/c/pay/cs',
    });

    const res = await post(`${PROMO_JOIN_COOKIE}=${token}`, 'CA', undefined, { tier: 'max' });
    expect(res.status).toBe(200);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      sku: 'promo_max_annual',
      tier: 'family',
      priceId: 'price_max_cad',
    });
  });

  it('501s during the window when the founding price id is missing', async () => {
    vi.stubEnv('HOLIDAY_PROMO_ENABLED', 'true');
    vi.stubEnv('PROMO_NEW_VISITOR_CHECKOUT_ENABLED', 'true');
    vi.stubEnv('AUTH_SECRET', 'test-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test');
    vi.stubEnv('STRIPE_PRICE_PLUS_ANNUAL', 'price_cad_yr');
    const token = signPromoJoinBinding({
      familyId: 'fam-9',
      userId: 'user-9',
      externalAuthId: 'sms:abc',
    });

    const res = await post(`${PROMO_JOIN_COOKIE}=${token}`);
    expect(res.status).toBe(501);
    expect(createMock).not.toHaveBeenCalled();
  });
});
