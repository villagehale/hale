import { describe, expect, it } from 'vitest';
import { familyAlreadySubscribed } from './already-subscribed.js';

describe('familyAlreadySubscribed', () => {
  it('is true only while the household is on a paid tier', () => {
    expect(
      familyAlreadySubscribed({ planTier: 'plus', stripeSubscriptionId: 'sub_live' }),
    ).toBe(true);
    expect(
      familyAlreadySubscribed({ planTier: 'family', stripeSubscriptionId: null }),
    ).toBe(true);
    expect(
      familyAlreadySubscribed({ planTier: 'free', stripeSubscriptionId: null }),
    ).toBe(false);
  });

  it('does not treat a leftover Stripe id after cancellation as paid', () => {
    expect(
      familyAlreadySubscribed({ planTier: 'free', stripeSubscriptionId: 'sub_old' }),
    ).toBe(false);
  });
});
