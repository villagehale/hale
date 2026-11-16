import { afterEach, describe, expect, it, vi } from 'vitest';

const retrieveMock = vi.fn();
vi.mock('~/lib/billing/stripe-client', () => ({
  stripeCheckoutClientFromEnv: () => ({
    createCheckoutSession: vi.fn(),
    retrieveCheckoutSession: (...args: unknown[]) => retrieveMock(...args),
  }),
}));

async function get(url: string) {
  const { GET } = await import('./route');
  return GET(new Request(url));
}

describe('GET /api/billing/checkout-session', () => {
  afterEach(() => {
    vi.resetModules();
    retrieveMock.mockReset();
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
      amount_total: 7900,
      currency: 'cad',
    });
    const res = await get(
      'https://app.example.com/api/billing/checkout-session?session_id=cs_test_paid&value=1&currency=USD',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      transactionId: 'cs_test_paid',
      value: 79,
      currency: 'CAD',
      paid: true,
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
});
