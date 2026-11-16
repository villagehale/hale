import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type PriceTierMap,
  checkoutPriceIdFromEnv,
  eventIdFromStripeEvent,
  familyIdFromStripeEvent,
  isStripeCheckoutConfigured,
  paidEventOccurredAt,
  paymentLinkTierOptionsFromEnv,
  planTierFromStripeEvent,
  priceTierMapFromEnv,
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

  it('keeps a founding yearly invoice.paid on plus after the promo cutoff', () => {
    const map = priceTierMapFromEnv({
      STRIPE_PRICE_FOUNDING_ANNUAL_USD: 'price_founding_usd',
    });
    const paid = {
      id: 'evt_renew',
      type: 'invoice.paid',
      data: { object: { lines: { data: [{ price: { id: 'price_founding_usd' } }] } } },
    };
    expect(map.price_founding_usd).toBe('plus');
    expect(planTierFromStripeEvent(paid, map)).toBe('plus');
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

  it('maps founding yearly and Plus USD list ids to plus', () => {
    expect(
      priceTierMapFromEnv({
        STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad',
        STRIPE_PRICE_FOUNDING_ANNUAL_USD: 'price_founding_usd',
        STRIPE_PRICE_PLUS_MONTHLY_USD: 'price_usd_mo',
        STRIPE_PRICE_PLUS_ANNUAL_USD: 'price_usd_yr',
      }),
    ).toEqual({
      price_founding_cad: 'plus',
      price_founding_usd: 'plus',
      price_usd_mo: 'plus',
      price_usd_yr: 'plus',
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
