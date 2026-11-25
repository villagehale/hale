import { describe, expect, it, vi } from 'vitest';
import { cancelPricingSubscription } from './pricing-checkout-stripe';

describe('cancelPricingSubscription', () => {
  it('deletes the new subscription and does not log the body', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await expect(cancelPricingSubscription('sk_test_example', 'sub_new', fetchImpl)).resolves.toBe(
      'canceled',
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.stripe.com/v1/subscriptions/sub_new',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('sk_test_example');
    info.mockRestore();
  });

  it('names a missing secret and does not call Stripe', async () => {
    const fetchImpl = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(cancelPricingSubscription('  ', 'sub_new', fetchImpl)).resolves.toBe(
      'not_configured',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'pricing_checkout_cancel_skipped',
        reason: 'not_configured',
      }),
      'pricing checkout',
    );
    warn.mockRestore();
  });
});
