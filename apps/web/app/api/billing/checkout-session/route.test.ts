import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const retrieveMock = vi.fn();
const dbMock = vi.fn();
const authMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/billing/stripe-client', () => ({
  stripeCheckoutClientFromEnv: () => ({
    createCheckoutSession: vi.fn(),
    retrieveCheckoutSession: (...args: unknown[]) => retrieveMock(...args),
  }),
}));
vi.mock('~/lib/db', () => ({ db: () => dbMock() }));

async function get(url: string) {
  const { GET } = await import('./route');
  return GET(new Request(url));
}

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const NOW_SECONDS = Math.floor(Date.now() / 1000);

function stripeSession(over: Record<string, unknown> = {}) {
  return {
    id: 'cs_test_state',
    status: 'complete',
    payment_status: 'paid',
    amount_total: 5900,
    currency: 'cad',
    created: NOW_SECONDS - 120,
    expires_at: NOW_SECONDS + 3600,
    client_reference_id: FAMILY_ID,
    customer: 'cus_secret',
    customer_details: { email: 'buyer@example.test', phone: '+15555550100' },
    metadata: { familyId: FAMILY_ID, tier: 'plus' },
    subscription: { id: 'sub_state', created: NOW_SECONDS - 100, status: 'active' },
    ...over,
  };
}

const STATE_URL = 'https://app.example.com/api/billing/checkout-session?session_id=cs_test_state';

describe('GET /api/billing/checkout-session', () => {
  beforeEach(() => {
    vi.stubEnv('CHECKOUT_SUCCESS_STATES_ENABLED', undefined);
    dbMock.mockImplementation(() => {
      throw new Error('no database in this test');
    });
  });

  afterEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    retrieveMock.mockReset();
    dbMock.mockReset();
  });

  it('400s a missing or crafted session id without calling Stripe', async () => {
    const res = await get('https://app.example.com/api/billing/checkout-session?value=1&currency=USD');
    expect(res.status).toBe(400);
    expect(retrieveMock).not.toHaveBeenCalled();
  });

  it('returns Stripe amount and currency, ignoring query value/currency', async () => {
    retrieveMock.mockResolvedValue({
      id: 'cs_test_paid',
      payment_status: 'paid',
      amount_total: 5900,
      currency: 'cad',
      metadata: { tier: 'plus' },
    });
    const res = await get(
      'https://app.example.com/api/billing/checkout-session?session_id=cs_test_paid&value=1&currency=USD',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      transactionId: 'cs_test_paid',
      value: 59,
      currency: 'CAD',
      paid: true,
      tier: 'plus',
    });
    expect(retrieveMock).toHaveBeenCalledWith('cs_test_paid');
  });

  it('returns paid:false for an unpaid session so the page will not fire', async () => {
    retrieveMock.mockResolvedValue({
      id: 'cs_test_open',
      payment_status: 'unpaid',
      amount_total: 5900,
      currency: 'usd',
    });
    const res = await get(
      'https://app.example.com/api/billing/checkout-session?session_id=cs_test_open',
    );
    expect(await res.json()).toMatchObject({ paid: false, value: 59, currency: 'USD' });
  });

  it('with the flag off sends no view, retrieves with one argument and reads no family', async () => {
    retrieveMock.mockResolvedValue(stripeSession());
    const res = await get(STATE_URL);
    expect(await res.json()).toEqual({
      transactionId: 'cs_test_state',
      value: 59,
      currency: 'CAD',
      paid: true,
      tier: 'plus',
    });
    expect(retrieveMock.mock.calls[0]).toEqual(['cs_test_state']);
    expect(dbMock).not.toHaveBeenCalled();
    expect(res.headers.get('cache-control')).toBeNull();
  });

  describe('with the flag on', () => {
    beforeEach(() => {
      vi.stubEnv('CHECKOUT_SUCCESS_STATES_ENABLED', 'true');
      authMock.mockResolvedValue(null);
    });

    afterEach(() => {
      authMock.mockReset();
    });

    it('answers a holder of the session id alone with the Stripe facts and no view, uncached', async () => {
      retrieveMock.mockResolvedValue(stripeSession());
      const res = await get(STATE_URL);
      expect(retrieveMock.mock.calls[0]).toEqual(['cs_test_state', { expand: ['subscription'] }]);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      expect(await res.json()).toEqual({
        transactionId: 'cs_test_state',
        value: 59,
        currency: 'CAD',
        paid: true,
        tier: 'plus',
      });
      expect(authMock).toHaveBeenCalledTimes(1);
      expect(dbMock).not.toHaveBeenCalled();
    });

    it('keeps family, customer, email and phone out of the body', async () => {
      retrieveMock.mockResolvedValue(stripeSession());
      const body = await (await get(STATE_URL)).text();
      expect(body).toContain('cs_test_state');
      for (const secret of [FAMILY_ID, 'familyId', 'cus_secret', 'buyer@example.test', '+1555']) {
        expect(body).not.toContain(secret);
      }
    });

    it('gives a signed-in viewer the Stripe facts when their seat cannot be read', async () => {
      authMock.mockResolvedValue({ user: { id: 'auth-viewer' } });
      retrieveMock.mockResolvedValue(stripeSession());
      const res = await get(STATE_URL);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        transactionId: 'cs_test_state',
        value: 59,
        currency: 'CAD',
        paid: true,
        tier: 'plus',
      });
      expect(dbMock).toHaveBeenCalled();
    });

    it('still 404s a session Stripe does not know, with no view', async () => {
      retrieveMock.mockResolvedValue(null);
      const res = await get(STATE_URL);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    });
  });
});
