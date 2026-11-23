import { describe, expect, it, vi } from 'vitest';
import { readNoticeSubscription, stripeSubscriptionReaderFromEnv } from './subscription-read';

/** VIL-735 · the reader never reaches Stripe in a test: `fetch` is injected. */

const END = Date.UTC(2027, 10, 21, 17, 0, 0) / 1000;

describe('readNoticeSubscription', () => {
  it('reads the period end from the item (current API versions)', () => {
    expect(
      readNoticeSubscription({
        status: 'active',
        created: 1_700_000_000,
        cancel_at_period_end: true,
        items: { data: [{ current_period_end: END }] },
      }),
    ).toEqual({
      status: 'active',
      createdAt: new Date(1_700_000_000_000),
      currentPeriodEnd: new Date(END * 1000),
      cancelAtPeriodEnd: true,
    });
  });

  it('falls back to the top-level period end (older API versions)', () => {
    expect(
      readNoticeSubscription({ status: 'trialing', current_period_end: END }).currentPeriodEnd,
    ).toEqual(new Date(END * 1000));
  });

  it('names a missing period end as null, never a guessed date', () => {
    expect(readNoticeSubscription({ status: 'active' }).currentPeriodEnd).toBeNull();
  });
});

describe('stripeSubscriptionReaderFromEnv', () => {
  it('is absent without a key', () => {
    expect(stripeSubscriptionReaderFromEnv({})).toBeNull();
  });

  it('GETs exactly that subscription and throws on a failed read', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ status: 'active' }), { status: 200 }),
    );
    const reader = stripeSubscriptionReaderFromEnv(
      { STRIPE_SECRET_KEY: 'sk_test_x' },
      fetchImpl as unknown as typeof fetch,
    );
    await expect(reader?.read('sub_1')).resolves.toMatchObject({ status: 'active' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0 as never]).toBe(
      'https://api.stripe.com/v1/subscriptions/sub_1',
    );

    const failing = stripeSubscriptionReaderFromEnv(
      { STRIPE_SECRET_KEY: 'sk_test_x' },
      (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch,
    );
    await expect(failing?.read('sub_1')).rejects.toThrow('stripe lookup failed: 500');
  });
});
