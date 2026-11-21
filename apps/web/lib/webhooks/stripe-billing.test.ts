import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type PriceTierMap,
  type RevokeFacts,
  chargeRevokeDecision,
  checkoutPriceIdFromEnv,
  disputeOutcome,
  eventIdFromStripeEvent,
  familyIdFromStripeEvent,
  isStripeCheckoutConfigured,
  paidEventOccurredAt,
  paymentLinkTierOptionsFromEnv,
  planTierFromStripeEvent,
  priceTierMapFromEnv,
  refundOutcome,
  stripeRefsFromStripeEvent,
  verifyStripeBillingSignature,
} from './stripe-billing.js';

/**
 * Fixtures hand-built to match REAL Stripe webhook shapes (verified against the
 * stripe-node types), never copied from runtime output:
 *   - checkout.session.completed carries NO line_items/price on the webhook (they're
 *     only present when explicitly expanded, which webhooks never are). We grant from
 *     OUR OWN metadata.tier (set at session creation) + client_reference_id/metadata.
 *   - customer.subscription.created/updated carry items.data[0].price.id + metadata.
 *   - customer.subscription.deleted → 'free'.
 *   - (anything else) → null.
 */

const PRICE_PLUS = 'price_plus_test';
const PRICE_FAMILY = 'price_family_test';
const MAP: PriceTierMap = { [PRICE_PLUS]: 'plus', [PRICE_FAMILY]: 'family' };
const FAMILY_ID = 'fam-123';

function subscriptionEvent(type: string, priceId: string, familyId: string | null = FAMILY_ID) {
  const object: Record<string, unknown> = {
    items: { data: [{ price: { id: priceId } }] },
  };
  if (familyId) object.metadata = { familyId };
  return { id: 'evt_sub_1', type, data: { object } };
}

/** A real checkout.session.completed webhook: metadata.tier + family refs, NO price. */
function checkoutCompleted(tier: string | null, familyId: string | null = FAMILY_ID) {
  const metadata: Record<string, string> = {};
  if (tier) metadata.tier = tier;
  if (familyId) metadata.familyId = familyId;
  const object: Record<string, unknown> = { metadata };
  if (familyId) object.client_reference_id = familyId;
  return { id: 'evt_checkout_1', type: 'checkout.session.completed', data: { object } };
}

describe('planTierFromStripeEvent', () => {
  it('maps a Plus checkout completion to plus via our metadata.tier (no price on webhook)', () => {
    expect(planTierFromStripeEvent(checkoutCompleted('plus'), MAP)).toBe('plus');
  });

  it('maps a Family checkout completion to family via our metadata.tier', () => {
    expect(planTierFromStripeEvent(checkoutCompleted('family'), MAP)).toBe('family');
  });

  it('returns null for a checkout session with no metadata.tier (never guesses)', () => {
    expect(planTierFromStripeEvent(checkoutCompleted(null), MAP)).toBeNull();
  });

  it('returns null for a checkout session whose metadata.tier is not a paid tier', () => {
    expect(planTierFromStripeEvent(checkoutCompleted('free'), MAP)).toBeNull();
    expect(planTierFromStripeEvent(checkoutCompleted('bogus'), MAP)).toBeNull();
  });

  it('maps a subscription creation (primary activation) to the price tier', () => {
    const created = subscriptionEvent('customer.subscription.created', PRICE_PLUS);
    expect(planTierFromStripeEvent(created, MAP)).toBe('plus');
  });

  it('maps a subscription update to the new price tier', () => {
    const upgrade = subscriptionEvent('customer.subscription.updated', PRICE_FAMILY);
    expect(planTierFromStripeEvent(upgrade, MAP)).toBe('family');
  });

  it('maps a subscription deletion to free (downgrade)', () => {
    const cancel = { id: 'evt_1', type: 'customer.subscription.deleted', data: { object: {} } };
    expect(planTierFromStripeEvent(cancel, MAP)).toBe('free');
  });

  it('returns null for an unrelated event type', () => {
    const unrelated = subscriptionEvent('invoice.payment_succeeded', PRICE_PLUS);
    expect(planTierFromStripeEvent(unrelated, MAP)).toBeNull();
  });

  it('returns null (never silently grants a tier) for an unknown price id', () => {
    const unknownPrice = subscriptionEvent('customer.subscription.updated', 'price_unmapped');
    expect(planTierFromStripeEvent(unknownPrice, MAP)).toBeNull();
  });

  it('returns null for a malformed / non-object payload', () => {
    expect(planTierFromStripeEvent(null, MAP)).toBeNull();
    expect(planTierFromStripeEvent('not-json', MAP)).toBeNull();
    expect(planTierFromStripeEvent({ type: 'checkout.session.completed' }, MAP)).toBeNull();
  });

  it('grants the Payment Link tier only when the event names that link', () => {
    const event = {
      id: 'evt_plink',
      type: 'checkout.session.completed',
      data: {
        object: {
          payment_link: 'plink_year',
          client_reference_id: FAMILY_ID,
          metadata: {},
        },
      },
    };
    expect(
      planTierFromStripeEvent(event, MAP, {
        paymentLinkId: 'plink_year',
        paymentLinkTier: 'plus',
      }),
    ).toBe('plus');
    expect(
      planTierFromStripeEvent(event, MAP, {
        paymentLinkId: 'plink_other',
        paymentLinkTier: 'plus',
      }),
    ).toBeNull();
    expect(planTierFromStripeEvent(event, MAP)).toBeNull();
    expect(
      planTierFromStripeEvent(event, MAP, {
        paymentLinkId: 'plink_year',
        paymentLinkTier: 'plus',
        allowPaymentLink: false,
      }),
    ).toBeNull();
  });

  it('disables the Payment Link fallback while the founding window is open', () => {
    const env = {
      STRIPE_PAYMENT_LINK_ID: 'plink_year',
      STRIPE_PAYMENT_LINK_TIER: 'plus',
    };
    expect(paymentLinkTierOptionsFromEnv(env, new Date('2026-11-16T12:00:00-05:00'))).toMatchObject(
      { allowPaymentLink: false },
    );
    expect(paymentLinkTierOptionsFromEnv(env, new Date('2027-01-01T00:00:00-05:00'))).toMatchObject(
      { allowPaymentLink: true },
    );
  });

  it('maps invoice.paid from the line price and refuses an unknown price', () => {
    const paid = {
      id: 'evt_inv',
      type: 'invoice.paid',
      data: { object: { lines: { data: [{ price: { id: PRICE_FAMILY } }] } } },
    };
    expect(planTierFromStripeEvent(paid, MAP)).toBe('family');
    const unknown = {
      id: 'evt_inv_2',
      type: 'invoice.paid',
      data: {
        object: { lines: { data: [{ pricing: { price_details: { price: 'price_nope' } } }] } },
      },
    };
    expect(planTierFromStripeEvent(unknown, MAP)).toBeNull();
  });

  it('keeps a promo yearly invoice.paid on plus or family after the promo cutoff', () => {
    const map = priceTierMapFromEnv({
      STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD: 'price_plus_usd',
      STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD: 'price_max_cad',
    });
    const plusPaid = {
      id: 'evt_renew',
      type: 'invoice.paid',
      data: { object: { lines: { data: [{ price: { id: 'price_plus_usd' } }] } } },
    };
    const maxPaid = {
      id: 'evt_renew_max',
      type: 'invoice.paid',
      data: { object: { lines: { data: [{ price: { id: 'price_max_cad' } }] } } },
    };
    expect(map.price_plus_usd).toBe('plus');
    expect(map.price_max_cad).toBe('family');
    expect(planTierFromStripeEvent(plusPaid, map)).toBe('plus');
    expect(planTierFromStripeEvent(maxPaid, map)).toBe('family');
  });

  it('maps Max and a known price id onto a paid tier so a payer is not left on free', () => {
    expect(planTierFromStripeEvent(checkoutCompleted('Max'), MAP)).toBe('family');
    expect(planTierFromStripeEvent(checkoutCompleted('PLUS'), MAP)).toBe('plus');
    const priced = {
      id: 'evt_price',
      type: 'checkout.session.completed',
      data: { object: { metadata: { priceId: PRICE_FAMILY, familyId: FAMILY_ID } } },
    };
    expect(planTierFromStripeEvent(priced, MAP)).toBe('family');
    expect(planTierFromStripeEvent(checkoutCompleted('gold'), MAP)).toBeNull();
  });
});

describe('chargeRevokeDecision', () => {
  it('revokes a full refund or dispute when the subscription is cancelled, and keeps a partial', () => {
    const full = {
      id: 'evt_r',
      type: 'charge.refunded',
      data: {
        object: {
          amount: 7900,
          amount_refunded: 7900,
          refunded: true,
          invoice: { subscription: { id: 'sub_1', status: 'canceled' } },
        },
      },
    };
    expect(chargeRevokeDecision(full)).toEqual({ action: 'revoke', kind: 'refund' });
    const partial = {
      id: 'evt_p',
      type: 'charge.refunded',
      data: { object: { amount: 7900, amount_refunded: 1000, refunded: false } },
    };
    expect(chargeRevokeDecision(partial)).toEqual({
      action: 'keep',
      reason: 'partial_refund',
      kind: 'refund',
    });
    const live = {
      id: 'evt_live',
      type: 'charge.dispute.created',
      data: { object: { subscription: { id: 'sub_1', status: 'active' } } },
    };
    expect(chargeRevokeDecision(live)).toEqual({
      action: 'keep',
      reason: 'active_subscription',
      kind: 'dispute',
    });
    const dispute = {
      id: 'evt_d',
      type: 'charge.dispute.created',
      data: { object: { subscription: { id: 'sub_1', status: 'canceled' } } },
    };
    expect(chargeRevokeDecision(dispute)).toEqual({ action: 'revoke', kind: 'dispute' });
  });
});

describe('refund and dispute outcomes', () => {
  const NOW = 1_780_000_000;
  const SETTLED = NOW - 30 * 86_400;
  const NOTHING = { paid: [], refundedIds: [], truncated: false };
  const PLUS_SIBLING = {
    paid: [{ id: 'sub_b', priceId: 'p_plus' }],
    refundedIds: [],
    truncated: false,
  };
  const MAX_SIBLING = {
    paid: [{ id: 'sub_b', priceId: 'p_max' }],
    refundedIds: [],
    truncated: false,
  };
  const REFUNDED_SIBLING = { paid: [], refundedIds: ['sub_b'], truncated: false };
  const TIERS: PriceTierMap = { p_plus: 'plus', p_max: 'family' };

  const facts = (over: Partial<RevokeFacts> = {}): RevokeFacts => ({
    flagOn: false,
    subscriptionId: 'sub_s',
    subscriptionStatus: 'active',
    subscriptionCreated: SETTLED,
    namesAnotherFamily: false,
    periodStanding: 'current',
    planTier: 'plus',
    storedSubscriptionId: 'sub_s',
    nowSeconds: NOW,
    other: NOTHING,
    priceTierMap: TIERS,
    ...over,
  });
  const ENDED = { subscriptionStatus: 'canceled' };
  const ON = { flagOn: true };

  describe('refundOutcome', () => {
    it.each([
      ['row 1: partial refund', { partial: true }, { action: 'keep', reason: 'partial_refund' }],
      [
        'row 2: no subscription',
        { subscriptionId: null, subscriptionStatus: null },
        { action: 'unresolved', reason: 'subscription_unresolved' },
      ],
      [
        'row 2: S names another family',
        { namesAnotherFamily: true, ...ENDED },
        { action: 'unresolved', reason: 'subscription_unresolved' },
      ],
      [
        'row 2: an id with no status proves nothing',
        { subscriptionStatus: null },
        { action: 'unresolved', reason: 'subscription_unresolved' },
      ],
      [
        'row 3a: ended, already free',
        { ...ENDED, planTier: 'free', other: null },
        { action: 'keep', reason: 'already_free' },
      ],
      [
        'row 3b: ended, another paid subscription',
        { ...ENDED, other: PLUS_SIBLING },
        { action: 'keep', reason: 'active_subscription' },
      ],
      [
        'row 3b: a truncated scan counts as paid',
        { ...ENDED, other: { ...NOTHING, truncated: true } },
        { action: 'keep', reason: 'active_subscription' },
      ],
      [
        'row 3c: ended, nothing else, stored is S',
        ENDED,
        { action: 'drop', cancelSubscriptionIds: [] },
      ],
      [
        'row 3c: ended, nothing else, nothing stored',
        { ...ENDED, storedSubscriptionId: null },
        { action: 'drop', cancelSubscriptionIds: [] },
      ],
      [
        'row 3d: ended, stored names another, flag off',
        { ...ENDED, storedSubscriptionId: 'sub_other' },
        { action: 'unresolved', reason: 'subscription_unresolved' },
      ],
      [
        'row 3e: ended, stored names another, flag on',
        { ...ENDED, ...ON, storedSubscriptionId: 'sub_other' },
        { action: 'drop', cancelSubscriptionIds: [] },
      ],
      ['row 4: live, flag off', { other: null }, { action: 'keep', reason: 'active_subscription' }],
      [
        'row 4: stalled, flag off',
        { subscriptionStatus: 'unpaid', other: null },
        { action: 'keep', reason: 'subscription_not_ended' },
      ],
      [
        'row 5a: live, older invoice',
        { ...ON, periodStanding: 'older', other: null },
        { action: 'keep', reason: 'older_invoice' },
      ],
      [
        'row 5b: live, period unproven',
        { ...ON, periodStanding: 'unproven', other: null },
        { action: 'unresolved', reason: 'current_period_unproven' },
      ],
      [
        'row 5b: a null standing on a live subscription reads as unproven',
        { ...ON, periodStanding: null, other: null },
        { action: 'unresolved', reason: 'current_period_unproven' },
      ],
      [
        'row 5c: current, another paid subscription',
        { ...ON, other: PLUS_SIBLING },
        { action: 'keep', reason: 'duplicate_subscription' },
      ],
      [
        'row 5c: stalled, another paid subscription',
        { ...ON, subscriptionStatus: 'unpaid', periodStanding: 'older', other: PLUS_SIBLING },
        { action: 'keep', reason: 'duplicate_subscription' },
      ],
      ['row 5d: current, nothing else', ON, { action: 'drop', cancelSubscriptionIds: ['sub_s'] }],
      [
        'row 5d: stalled ends whichever period the charge paid',
        { ...ON, subscriptionStatus: 'paused', periodStanding: 'older' },
        { action: 'drop', cancelSubscriptionIds: ['sub_s'] },
      ],
    ] as const)('%s', (_name, over, expected) => {
      const { partial, ...rest } = over as Partial<RevokeFacts> & { partial?: boolean };
      expect(refundOutcome({ ...facts(rest), partial: partial === true })).toEqual(expected);
    });

    it('asks for the scan only on the rows that use it', () => {
      const scan = { action: 'needs_scan' };
      const outcome = (over: Partial<RevokeFacts>) =>
        refundOutcome({ ...facts({ ...over, other: null }), partial: false });
      expect(outcome(ENDED)).toEqual(scan);
      expect(outcome({ ...ENDED, ...ON, storedSubscriptionId: 'sub_other' })).toEqual(scan);
      expect(outcome(ON)).toEqual(scan);
      expect(outcome({ ...ON, subscriptionStatus: 'unpaid' })).toEqual(scan);
    });

    it('with the flag on, a refunded sibling is not paid and every drop cancels it', () => {
      expect(
        refundOutcome({ ...facts({ ...ON, other: REFUNDED_SIBLING }), partial: false }),
      ).toEqual({ action: 'drop', cancelSubscriptionIds: ['sub_s', 'sub_b'] });
      expect(
        refundOutcome({ ...facts({ ...ON, ...ENDED, other: REFUNDED_SIBLING }), partial: false }),
      ).toEqual({ action: 'drop', cancelSubscriptionIds: ['sub_b'] });
    });

    it('with the flag off, a refunded sibling counts as paid so nothing is cancelled', () => {
      expect(
        refundOutcome({ ...facts({ ...ENDED, other: REFUNDED_SIBLING }), partial: false }),
      ).toEqual({
        action: 'keep',
        reason: 'active_subscription',
      });
    });

    it('waits while a subscription that would drop is younger than the search index', () => {
      const young = { subscriptionCreated: NOW - 600 };
      expect(refundOutcome({ ...facts({ ...ON, ...young }), partial: false })).toEqual({
        action: 'wait',
      });
      expect(refundOutcome({ ...facts({ ...ENDED, ...young }), partial: false })).toEqual({
        action: 'wait',
      });
    });

    it('decides at exactly the settle boundary, and a null created counts as settled', () => {
      expect(
        refundOutcome({ ...facts({ ...ON, subscriptionCreated: NOW - 3600 }), partial: false }),
      ).toEqual({ action: 'drop', cancelSubscriptionIds: ['sub_s'] });
      expect(
        refundOutcome({ ...facts({ ...ON, subscriptionCreated: NOW - 3599 }), partial: false }),
      ).toEqual({ action: 'wait' });
      expect(
        refundOutcome({ ...facts({ ...ON, subscriptionCreated: null }), partial: false }),
      ).toEqual({ action: 'drop', cancelSubscriptionIds: ['sub_s'] });
    });

    it('a young subscription that keeps the plan does not wait', () => {
      expect(
        refundOutcome({
          ...facts({ ...ON, subscriptionCreated: NOW - 60, other: PLUS_SIBLING }),
          partial: false,
        }),
      ).toEqual({ action: 'keep', reason: 'duplicate_subscription' });
    });

    describe('the plan on file against what still pays, flag on', () => {
      const DIFFERS = { action: 'unresolved', reason: 'surviving_plan_differs' };

      it('never moves the tier: a survivor on another tier pages instead', () => {
        expect(
          refundOutcome({
            ...facts({ ...ON, planTier: 'family', other: PLUS_SIBLING }),
            partial: false,
          }),
        ).toEqual(DIFFERS);
        expect(
          refundOutcome({
            ...facts({ ...ON, ...ENDED, planTier: 'plus', other: MAX_SIBLING }),
            partial: false,
          }),
        ).toEqual(DIFFERS);
      });

      it('keeps with no page when the tier matches or the family is on free', () => {
        expect(refundOutcome({ ...facts({ ...ON, other: PLUS_SIBLING }), partial: false })).toEqual(
          {
            action: 'keep',
            reason: 'duplicate_subscription',
          },
        );
        expect(
          refundOutcome({
            ...facts({ ...ON, planTier: 'free', other: MAX_SIBLING }),
            partial: false,
          }),
        ).toEqual({ action: 'keep', reason: 'duplicate_subscription' });
      });

      it.each([
        [
          'an unknown price',
          { paid: [{ id: 'sub_b', priceId: 'p_unknown' }], refundedIds: [], truncated: false },
        ],
        ['no price', { paid: [{ id: 'sub_b', priceId: null }], refundedIds: [], truncated: false }],
        [
          'mixed tiers',
          {
            paid: [
              { id: 'sub_b', priceId: 'p_plus' },
              { id: 'sub_c', priceId: 'p_max' },
            ],
            refundedIds: [],
            truncated: false,
          },
        ],
        [
          'a truncated scan',
          { paid: [{ id: 'sub_b', priceId: 'p_plus' }], refundedIds: [], truncated: true },
        ],
      ])('pages instead of guessing on %s', (_name, other) => {
        expect(refundOutcome({ ...facts({ ...ON, other }), partial: false })).toEqual(DIFFERS);
      });

      it('stays quiet with the flag off', () => {
        expect(
          refundOutcome({
            ...facts({ ...ENDED, planTier: 'family', other: PLUS_SIBLING }),
            partial: false,
          }),
        ).toEqual({ action: 'keep', reason: 'active_subscription' });
      });
    });
  });

  describe('disputeOutcome', () => {
    const KEPT = { action: 'unresolved', reason: 'dispute_plan_kept' };
    const UNRESOLVED = { action: 'unresolved', reason: 'subscription_unresolved' };
    const NO_SUB = { subscriptionId: null, subscriptionStatus: null, periodStanding: null };

    it.each([
      ['D1: live', { other: null }, KEPT],
      ['D1: stalled', { subscriptionStatus: 'unpaid', other: null }, KEPT],
      ['D2: ended, another paid', { ...ENDED, other: PLUS_SIBLING }, KEPT],
      ['D2: ended, a refunded sibling still bills', { ...ENDED, other: REFUNDED_SIBLING }, KEPT],
      ['D2: ended, truncated scan', { ...ENDED, other: { ...NOTHING, truncated: true } }, KEPT],
      ['D3: ended, stored is S', ENDED, { action: 'drop', cancelSubscriptionIds: [] }],
      [
        'D3: ended, nothing stored',
        { ...ENDED, storedSubscriptionId: null },
        { action: 'drop', cancelSubscriptionIds: [] },
      ],
      [
        'D4: ended, stored names another',
        { ...ENDED, storedSubscriptionId: 'sub_other' },
        UNRESOLVED,
      ],
      ['D5: no S, stored present', { ...NO_SUB, other: null }, UNRESOLVED],
      [
        'D6: no S, nothing stored, nothing paid',
        { ...NO_SUB, storedSubscriptionId: null },
        { action: 'drop', cancelSubscriptionIds: [] },
      ],
      [
        'D7: no S, nothing stored, paid found',
        { ...NO_SUB, storedSubscriptionId: null, other: PLUS_SIBLING },
        KEPT,
      ],
      ['S names another family', { ...ENDED, namesAnotherFamily: true }, UNRESOLVED],
    ] as const)('%s', (_name, over, expected) => {
      expect(disputeOutcome(facts(over as Partial<RevokeFacts>))).toEqual(expected);
    });

    it('D3 waits for a young subscription, D6 has none to age', () => {
      expect(disputeOutcome(facts({ ...ENDED, subscriptionCreated: NOW - 60 }))).toEqual({
        action: 'wait',
      });
      expect(
        disputeOutcome(facts({ ...NO_SUB, storedSubscriptionId: null, subscriptionCreated: null })),
      ).toEqual({ action: 'drop', cancelSubscriptionIds: [] });
    });

    it('asks for the scan only on the rows that use it', () => {
      const scan = { action: 'needs_scan' };
      expect(disputeOutcome(facts({ ...ENDED, other: null }))).toEqual(scan);
      expect(disputeOutcome(facts({ ...NO_SUB, storedSubscriptionId: null, other: null }))).toEqual(
        scan,
      );
    });

    it('never cancels anything, with the flag on or off', () => {
      for (const flagOn of [true, false]) {
        const outcome = disputeOutcome(facts({ ...ENDED, flagOn }));
        expect(outcome).toEqual({ action: 'drop', cancelSubscriptionIds: [] });
      }
    });
  });
});

describe('familyIdFromStripeEvent', () => {
  it('reads client_reference_id off a checkout session', () => {
    expect(familyIdFromStripeEvent(checkoutCompleted('plus', 'fam-abc'))).toBe('fam-abc');
  });

  it('reads metadata.familyId off a subscription', () => {
    const evt = subscriptionEvent('customer.subscription.updated', PRICE_PLUS, 'fam-xyz');
    expect(familyIdFromStripeEvent(evt)).toBe('fam-xyz');
  });

  it('returns null when the event carries no family reference', () => {
    expect(familyIdFromStripeEvent(checkoutCompleted('plus', null))).toBeNull();
    expect(familyIdFromStripeEvent(null)).toBeNull();
  });

  it('reads family id from invoice subscription metadata', () => {
    const event = {
      id: 'evt_inv',
      type: 'invoice.paid',
      data: {
        object: {
          parent: { subscription_details: { metadata: { familyId: 'fam-inv' } } },
        },
      },
    };
    expect(familyIdFromStripeEvent(event)).toBe('fam-inv');
  });
});

describe('stripeRefsFromStripeEvent', () => {
  it('reads a customer id and a subscription id off the object', () => {
    const event = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { customer: 'cus_1', subscription: { id: 'sub_1' } } },
    };
    expect(stripeRefsFromStripeEvent(event)).toEqual({
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
    });
  });

  it('uses the subscription object id when the event is customer.subscription.*', () => {
    const event = {
      id: 'evt_sub',
      type: 'customer.subscription.updated',
      data: {
        object: {
          id: 'sub_self',
          customer: 'cus_1',
          items: { data: [{ price: { id: 'price_plus' } }] },
        },
      },
    };
    expect(stripeRefsFromStripeEvent(event)).toEqual({
      customerId: 'cus_1',
      subscriptionId: 'sub_self',
    });
  });
});

describe('paidEventOccurredAt', () => {
  it('reads Stripe event.created unix seconds and ignores a later fallback', () => {
    const during = Math.floor(new Date('2026-11-16T12:00:00-05:00').getTime() / 1000);
    const after = new Date('2027-01-02T12:00:00-05:00');
    expect(paidEventOccurredAt({ created: during }, after)).toEqual(
      new Date('2026-11-16T12:00:00-05:00'),
    );
  });

  it('falls back when created is missing', () => {
    const fallback = new Date('2027-01-02T12:00:00-05:00');
    expect(paidEventOccurredAt({ id: 'evt_1' }, fallback)).toBe(fallback);
  });
});

describe('eventIdFromStripeEvent', () => {
  it('returns the top-level event id', () => {
    expect(eventIdFromStripeEvent(checkoutCompleted('plus'))).toBe('evt_checkout_1');
  });

  it('returns null when the id is missing', () => {
    expect(eventIdFromStripeEvent({ type: 'checkout.session.completed' })).toBeNull();
  });
});

describe('priceTierMapFromEnv', () => {
  it('maps every configured tier+period price id to its tier', () => {
    expect(
      priceTierMapFromEnv({
        STRIPE_PRICE_PLUS_MONTHLY: 'p_m',
        STRIPE_PRICE_PLUS_ANNUAL: 'p_a',
        STRIPE_PRICE_FAMILY_MONTHLY: 'f_m',
        STRIPE_PRICE_FAMILY_ANNUAL: 'f_a',
      }),
    ).toEqual({ p_m: 'plus', p_a: 'plus', f_m: 'family', f_a: 'family' });
  });

  it('omits price ids that are absent', () => {
    expect(priceTierMapFromEnv({ STRIPE_PRICE_PLUS_MONTHLY: 'p_m' })).toEqual({ p_m: 'plus' });
    expect(priceTierMapFromEnv({})).toEqual({});
  });

  it('maps promo yearly and Plus USD list ids to the right tier', () => {
    expect(
      priceTierMapFromEnv({
        STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD: 'price_plus_cad',
        STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD: 'price_plus_usd',
        STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD: 'price_max_cad',
        STRIPE_PRICE_PROMO_MAX_ANNUAL_USD: 'price_max_usd',
        STRIPE_PRICE_PLUS_MONTHLY_USD: 'price_usd_mo',
        STRIPE_PRICE_PLUS_ANNUAL_USD: 'price_usd_yr',
      }),
    ).toEqual({
      price_plus_cad: 'plus',
      price_plus_usd: 'plus',
      price_max_cad: 'family',
      price_max_usd: 'family',
      price_usd_mo: 'plus',
      price_usd_yr: 'plus',
    });
  });

  it('does not map leftover founding env names onto a paid tier', () => {
    expect(
      priceTierMapFromEnv({
        STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad',
        STRIPE_PRICE_FOUNDING_ANNUAL_USD: 'price_founding_usd',
      }),
    ).toEqual({});
  });

  it('maps Max list annual ids to family', () => {
    expect(
      priceTierMapFromEnv({
        STRIPE_PRICE_MAX_ANNUAL_CAD: 'price_max_list_cad',
        STRIPE_PRICE_MAX_ANNUAL_USD: 'price_max_list_usd',
      }),
    ).toEqual({
      price_max_list_cad: 'family',
      price_max_list_usd: 'family',
    });
  });
});

describe('checkoutPriceIdFromEnv', () => {
  it('picks the price id for the requested tier + period', () => {
    const env = { STRIPE_PRICE_PLUS_MONTHLY: 'p_m', STRIPE_PRICE_FAMILY_ANNUAL: 'f_a' };
    expect(checkoutPriceIdFromEnv('plus', 'monthly', env)).toBe('p_m');
    expect(checkoutPriceIdFromEnv('family', 'annual', env)).toBe('f_a');
    expect(checkoutPriceIdFromEnv('plus', 'annual', env)).toBeNull();
  });
});

describe('isStripeCheckoutConfigured', () => {
  const FULL_ENV = {
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_PRICE_PLUS_MONTHLY: 'p_m',
    STRIPE_PRICE_PLUS_ANNUAL: 'p_a',
    STRIPE_PRICE_FAMILY_MONTHLY: 'f_m',
    STRIPE_PRICE_FAMILY_ANNUAL: 'f_a',
  };

  it('is false with no env at all (the dormant default)', () => {
    expect(isStripeCheckoutConfigured({})).toBe(false);
  });

  it('is false when the secret key is present but a price id is missing', () => {
    const { STRIPE_PRICE_FAMILY_ANNUAL: _omit, ...partial } = FULL_ENV;
    expect(isStripeCheckoutConfigured(partial)).toBe(false);
  });

  it('is true only when the secret key and all four price ids are present', () => {
    expect(isStripeCheckoutConfigured(FULL_ENV)).toBe(true);
  });
});

describe('verifyStripeBillingSignature (Stripe t=,v1= scheme)', () => {
  const SECRET = 'whsec_test';
  const BODY = '{"id":"evt_1","type":"checkout.session.completed"}';
  const NOW = 1_700_000_000;

  function sign(body: string, secret: string, t: number): string {
    const hex = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    return `t=${t},v1=${hex}`;
  }

  it('refuses to process (not_configured) when STRIPE_WEBHOOK_SECRET is absent', () => {
    const result = verifyStripeBillingSignature(sign(BODY, SECRET, NOW), BODY, undefined, NOW);
    expect(result.status).toBe('not_configured');
  });

  it('reports invalid when configured but the signature header is missing', () => {
    expect(verifyStripeBillingSignature(null, BODY, SECRET, NOW).status).toBe('invalid');
  });

  it('verifies a correctly-signed, in-tolerance request', () => {
    const header = sign(BODY, SECRET, NOW);
    expect(verifyStripeBillingSignature(header, BODY, SECRET, NOW).status).toBe('verified');
  });

  it('rejects a tampered body (signature mismatch)', () => {
    const header = sign(BODY, SECRET, NOW);
    const result = verifyStripeBillingSignature(header, `${BODY} tampered`, SECRET, NOW);
    expect(result.status).toBe('invalid');
  });

  it('rejects a signature made with the wrong secret', () => {
    const header = sign(BODY, 'whsec_attacker', NOW);
    expect(verifyStripeBillingSignature(header, BODY, SECRET, NOW).status).toBe('invalid');
  });

  it('rejects a stale timestamp outside the tolerance window (replay defence)', () => {
    const header = sign(BODY, SECRET, NOW - 400);
    const result = verifyStripeBillingSignature(header, BODY, SECRET, NOW);
    expect(result.status).toBe('invalid');
  });

  it('accepts when one of several v1 signatures matches (key rotation)', () => {
    const good = createHmac('sha256', SECRET).update(`${NOW}.${BODY}`).digest('hex');
    const header = `t=${NOW},v1=${'0'.repeat(64)},v1=${good}`;
    expect(verifyStripeBillingSignature(header, BODY, SECRET, NOW).status).toBe('verified');
  });

  it('rejects a malformed header with no timestamp', () => {
    expect(verifyStripeBillingSignature('v1=deadbeef', BODY, SECRET, NOW).status).toBe('invalid');
  });
});
