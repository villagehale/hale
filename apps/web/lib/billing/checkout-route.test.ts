import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/billing/checkout: auth() is the 401 gate; absent Stripe keys it 501s
// (dormant); a valid request delegates to createBillingCheckout. We stub the
// session + the delegate + db so we assert the GATE, VALIDATION, and 501/DELEGATION,
// not the Stripe call or DB (covered in create-checkout.test). Poison @hale/db's
// createDb so a route that opened its own connection would fail loudly.
const authMock = vi.fn();
const createMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/billing/create-checkout', () => ({
  createBillingCheckout: (...a: unknown[]) => createMock(...a),
}));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('billing checkout route must NOT open its own DB connection');
    },
  };
});

const FULL_STRIPE_ENV: Record<string, string> = {
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_PRICE_PLUS_MONTHLY: 'price_pm',
  STRIPE_PRICE_PLUS_ANNUAL: 'price_pa',
  STRIPE_PRICE_FAMILY_MONTHLY: 'price_fm',
  STRIPE_PRICE_FAMILY_ANNUAL: 'price_fa',
};

function stubStripeEnv(): void {
  for (const [k, v] of Object.entries(FULL_STRIPE_ENV)) vi.stubEnv(k, v);
}

function session(id: string | null, email = 'p@example.com') {
  return id ? { user: { id, email } } : null;
}

async function callPost(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/billing/checkout/route');
  return POST(
    new Request('http://localhost/api/billing/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/billing/checkout', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    createMock.mockReset();
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns 401 when there is no session', async () => {
    authMock.mockResolvedValue(session(null));
    stubStripeEnv();
    const res = await callPost({ tier: 'plus' });
    expect(res.status).toBe(401);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a tier outside the paid set', async () => {
    authMock.mockResolvedValue(session('auth-1'));
    stubStripeEnv();
    const res = await callPost({ tier: 'free' });
    expect(res.status).toBe(400);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('returns 501 (dormant) when Stripe is not configured — never delegates', async () => {
    authMock.mockResolvedValue(session('auth-1'));
    // no stubStripeEnv: keys absent
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    const res = await callPost({ tier: 'plus', period: 'monthly' });
    expect(res.status).toBe(501);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('stripe_billing_not_live');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('delegates a valid configured request and returns the checkout url', async () => {
    authMock.mockResolvedValue(session('auth-1'));
    stubStripeEnv();
    createMock.mockResolvedValue({ status: 'created', url: 'https://checkout.stripe.com/x' });

    const res = await callPost({ tier: 'family', period: 'annual' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://checkout.stripe.com/x' });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[0]?.[0]).toMatchObject({
      tier: 'family',
      period: 'annual',
      priceId: 'price_fa',
    });
  });

  it('maps a familyless caller to 404', async () => {
    authMock.mockResolvedValue(session('auth-1'));
    stubStripeEnv();
    createMock.mockResolvedValue({ status: 'not_found' });
    const res = await callPost({ tier: 'plus', period: 'monthly' });
    expect(res.status).toBe(404);
  });
});
