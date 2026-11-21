import type { Database } from '@hale/db';
import type { PlanTier } from '@hale/types';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { applyStripeBillingEvent } from './stripe-billing-apply.js';
import type { PriceTierMap } from './stripe-billing.js';

/**
 * applyStripeBillingEvent is the DB write behind a VERIFIED Stripe billing event:
 * claim the event id (idempotency), write families.plan_tier, and audit (rule #6),
 * all in one transaction. Tested against an in-memory fake db that records writes
 * and models the unique-index claim (a redelivered event id conflicts → []). No
 * real Stripe, no real DB.
 */

const PRICE_PLUS = 'price_plus';
const PRICE_FAMILY = 'price_family';
const MAP: PriceTierMap = { [PRICE_PLUS]: 'plus', [PRICE_FAMILY]: 'family' };
const FAMILY_ID = 'fam-1';

/** Real checkout.session.completed shape: metadata.tier + family refs, no price. */
function checkout(eventId: string, tier: string | null, familyId: string | null = FAMILY_ID) {
  const metadata: Record<string, string> = {};
  if (tier) metadata.tier = tier;
  if (familyId) metadata.familyId = familyId;
  const object: Record<string, unknown> = { metadata };
  if (familyId) object.client_reference_id = familyId;
  return { id: eventId, type: 'checkout.session.completed', data: { object } };
}

function subscription(eventId: string, type: string, priceId: string, familyId = FAMILY_ID) {
  return {
    id: eventId,
    type,
    data: { object: { items: { data: [{ price: { id: priceId } }] }, metadata: { familyId } } },
  };
}

interface Recorder {
  planWrites: Array<{
    tier: string;
    stripeCustomerId?: string;
    stripeSubscriptionId?: string;
  }>;
  audits: Array<Record<string, unknown>>;
  claimed: Set<string>;
}

/**
 * Fake of the apply transaction: insert(stripe_billing_events).onConflictDoNothing()
 * .returning() yields [] for an already-claimed event id (the unique-index conflict)
 * and [{id}] for a fresh one; the families UPDATE returns [{id}] only when the family
 * exists (models the rowcount check), else [] → unknown_family. `preClaimed` seeds
 * event ids as already-processed (a redelivery); `familyExists:false` models an event
 * naming a family we don't have.
 */
function fakeDb(
  opts: { existingTier?: PlanTier; familyExists?: boolean; preClaimed?: string[] } = {},
): { db: Database; rec: Recorder } {
  const familyExists = opts.familyExists ?? true;
  const rec: Recorder = {
    planWrites: [],
    audits: [],
    claimed: new Set(opts.preClaimed ?? []),
  };
  const dialect = new PgDialect();
  const selectChain = () => ({
    from: () => ({
      where: (condition: SQL) => {
        // A marker read filters by verb and subscription in SQL: honour its bound parameters.
        const { params } = dialect.sqlToQuery(condition);
        const limit = async () => {
          if (params.some((p) => typeof p === 'string' && p.startsWith('billing_'))) {
            return rec.audits
              .filter(
                (a) =>
                  params.includes(a.actionTaken) &&
                  params.includes((a.after as { subscriptionId?: unknown }).subscriptionId),
              )
              .map((a) => ({ after: a.after, actionTaken: a.actionTaken }));
          }
          return familyExists && opts.existingTier ? [{ planTier: opts.existingTier }] : [];
        };
        return { limit, orderBy: () => ({ limit }) };
      },
    }),
  });
  const tx = {
    insert: (_table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        if ('eventId' in v) {
          return {
            onConflictDoNothing: () => ({
              returning: async () => {
                const eventId = v.eventId as string;
                if (rec.claimed.has(eventId)) return [];
                rec.claimed.add(eventId);
                return [{ id: 'claim' }];
              },
            }),
          };
        }
        rec.audits.push(v);
        return Promise.resolve(undefined);
      },
    }),
    select: selectChain,
    update: () => ({
      set: (v: { planTier: string; stripeCustomerId?: string; stripeSubscriptionId?: string }) => ({
        where: () => ({
          returning: async () => {
            if (!familyExists) return [];
            const recorded: {
              tier: string;
              stripeCustomerId?: string;
              stripeSubscriptionId?: string;
            } = { tier: v.planTier };
            if (v.stripeCustomerId) recorded.stripeCustomerId = v.stripeCustomerId;
            if (v.stripeSubscriptionId) recorded.stripeSubscriptionId = v.stripeSubscriptionId;
            rec.planWrites.push(recorded);
            return [{ id: FAMILY_ID }];
          },
        }),
      }),
    }),
  };
  const db = {
    transaction: async (cb: (t: typeof tx) => unknown) => cb(tx),
    select: selectChain,
  } as unknown as Database;
  return { db, rec };
}

describe('applyStripeBillingEvent', () => {
  it('applies a Plus checkout: writes plan_tier=plus + one audit row', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });

    const result = await applyStripeBillingEvent(checkout('evt_1', 'plus'), db, MAP);

    expect(result).toEqual({ status: 'applied', tier: 'plus' });
    expect(rec.planWrites).toEqual([{ tier: 'plus' }]);
    expect(rec.audits).toHaveLength(1);
    expect(rec.audits[0]).toMatchObject({
      familyId: FAMILY_ID,
      actionTaken: 'family_plan_updated',
      after: { planTier: 'plus', source: 'stripe', stripeEventId: 'evt_1' },
    });
  });

  it('is idempotent: a redelivered event id claims nothing, writes no tier, audits nothing', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free', preClaimed: ['evt_1'] });

    const result = await applyStripeBillingEvent(checkout('evt_1', 'plus'), db, MAP);

    expect(result).toEqual({ status: 'duplicate' });
    expect(rec.planWrites).toEqual([]);
    expect(rec.audits).toEqual([]);
  });

  it('activates on subscription.created (primary activation) via the price→tier map', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });

    const result = await applyStripeBillingEvent(
      subscription('evt_sub', 'customer.subscription.created', PRICE_FAMILY),
      db,
      MAP,
    );

    expect(result).toEqual({ status: 'applied', tier: 'family' });
    expect(rec.planWrites).toEqual([{ tier: 'family' }]);
  });

  it('acknowledges an unknown family as terminal (claims the event, no write, no audit)', async () => {
    const { db, rec } = fakeDb({ familyExists: false });

    const result = await applyStripeBillingEvent(checkout('evt_ghost', 'plus'), db, MAP);

    expect(result).toEqual({ status: 'unknown_family' });
    expect(rec.planWrites).toEqual([]);
    expect(rec.audits).toEqual([]);
    // the ledger still claimed the event so a retry is a no-op duplicate
    expect(rec.claimed.has('evt_ghost')).toBe(true);
  });

  it('downgrades to free on subscription deletion', async () => {
    const { db, rec } = fakeDb({ existingTier: 'family' });
    const event = {
      id: 'evt_del',
      type: 'customer.subscription.deleted',
      data: { object: { metadata: { familyId: FAMILY_ID } } },
    };

    const result = await applyStripeBillingEvent(event, db, MAP);

    expect(result).toEqual({ status: 'applied', tier: 'free' });
    expect(rec.planWrites).toEqual([{ tier: 'free' }]);
  });

  it('writes nothing for a subscription on an unknown price id (no silent tier grant)', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });

    const result = await applyStripeBillingEvent(
      subscription('evt_2', 'customer.subscription.updated', 'price_unmapped'),
      db,
      MAP,
    );

    expect(result).toEqual({ status: 'no_tier' });
    expect(rec.planWrites).toEqual([]);
    expect(rec.audits).toEqual([]);
  });

  it('writes nothing for an event with no family reference (unattributable)', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });

    const result = await applyStripeBillingEvent(checkout('evt_3', 'plus', null), db, MAP);

    expect(result).toEqual({ status: 'unbound' });
    expect(rec.planWrites).toEqual([]);
  });

  it('ignores an event with no id (cannot be deduped)', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });

    const result = await applyStripeBillingEvent(
      { type: 'checkout.session.completed', data: { object: { metadata: { tier: 'plus' } } } },
      db,
      MAP,
    );

    expect(result).toEqual({ status: 'ignored' });
    expect(rec.planWrites).toEqual([]);
  });

  it('stores the Stripe customer and subscription ids beside the tier', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });
    const event = checkout('evt_ids', 'plus');
    const object = (event.data as { object: Record<string, unknown> }).object;
    object.customer = 'cus_123';
    object.subscription = 'sub_123';

    const result = await applyStripeBillingEvent(event, db, MAP);

    expect(result).toEqual({ status: 'applied', tier: 'plus' });
    expect(rec.planWrites).toEqual([
      { tier: 'plus', stripeCustomerId: 'cus_123', stripeSubscriptionId: 'sub_123' },
    ]);
  });

  it('marks the family paid from invoice.paid when the line price is mapped', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });
    const event = {
      id: 'evt_inv',
      type: 'invoice.paid',
      data: {
        object: {
          customer: 'cus_9',
          lines: { data: [{ price: { id: PRICE_PLUS } }] },
          parent: {
            subscription_details: {
              subscription: 'sub_9',
              metadata: { familyId: FAMILY_ID },
            },
          },
        },
      },
    };

    const result = await applyStripeBillingEvent(event, db, MAP);

    expect(result).toEqual({ status: 'applied', tier: 'plus' });
    expect(rec.planWrites).toEqual([
      { tier: 'plus', stripeCustomerId: 'cus_9', stripeSubscriptionId: 'sub_9' },
    ]);
  });

  it('does not grant Plus for a list-price Payment Link during the promo; audits refund-ready and alerts', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });
    const alerts: Array<Record<string, unknown>> = [];
    const event = {
      id: 'evt_plink',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_plink',
          payment_link: 'plink_year',
          client_reference_id: FAMILY_ID,
          metadata: { familyId: FAMILY_ID, tier: 'plus', priceId: 'price_cad_mo' },
          line_items: { data: [{ price: { id: 'price_cad_mo' } }] },
        },
      },
    };

    const result = await applyStripeBillingEvent(
      event,
      db,
      MAP,
      {},
      {
        now: new Date('2026-11-16T12:00:00-05:00'),
        env: {
          STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad',
          STRIPE_PRICE_PLUS_MONTHLY: 'price_cad_mo',
          STRIPE_PAYMENT_LINK_ID: 'plink_year',
          STRIPE_PAYMENT_LINK_TIER: 'plus',
        },
        onDisallowedPrice: async (info) => {
          alerts.push(info);
          return 'sent';
        },
      },
    );

    expect(result).toEqual({ status: 'refund_ready', opsAlert: 'sent' });
    expect(rec.planWrites).toEqual([]);
    expect(rec.audits).toEqual([
      expect.objectContaining({
        familyId: FAMILY_ID,
        actionTaken: 'billing_refund_ready',
        after: expect.objectContaining({
          stripeEventId: 'evt_plink',
          sessionId: 'cs_plink',
          subscriptionId: null,
          priceIds: ['price_cad_mo'],
          reason: 'list_price',
          refund: 'ready',
          autoRefund: false,
        }),
      }),
    ]);
    expect(alerts).toEqual([
      {
        eventId: 'evt_plink',
        sessionId: 'cs_plink',
        priceIds: ['price_cad_mo'],
        reason: 'list_price',
      },
    ]);
    expect(JSON.stringify(alerts)).not.toMatch(/email|@|phone/i);
  });

  it('is idempotent on a redelivered disallowed session: no second alert, no grant', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free', preClaimed: ['evt_plink'] });
    const alerts: unknown[] = [];
    const event = {
      id: 'evt_plink',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_plink',
          payment_link: 'plink_year',
          metadata: { familyId: FAMILY_ID, tier: 'plus' },
        },
      },
    };

    const result = await applyStripeBillingEvent(
      event,
      db,
      MAP,
      {},
      {
        now: new Date('2026-11-16T12:00:00-05:00'),
        env: { STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad' },
        onDisallowedPrice: async (info) => {
          alerts.push(info);
          return undefined;
        },
      },
    );

    expect(result).toEqual({ status: 'duplicate' });
    expect(rec.planWrites).toEqual([]);
    expect(rec.audits).toEqual([]);
    expect(alerts).toEqual([]);
  });

  it('names skipped_not_configured on refund_ready when #ops is not configured', async () => {
    const { db } = fakeDb({ existingTier: 'free' });
    const event = {
      id: 'evt_skip',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_skip',
          payment_link: 'plink_year',
          metadata: { familyId: FAMILY_ID, tier: 'plus', priceId: 'price_cad_mo' },
        },
      },
    };

    const result = await applyStripeBillingEvent(
      event,
      db,
      MAP,
      {},
      {
        now: new Date('2026-11-16T12:00:00-05:00'),
        env: {
          STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad',
          STRIPE_PRICE_PLUS_MONTHLY: 'price_cad_mo',
        },
        onDisallowedPrice: async () => 'skipped_not_configured',
      },
    );

    expect(result).toEqual({ status: 'refund_ready', opsAlert: 'skipped_not_configured' });
  });

  it('does not grant Plus on later subscription.updated after a refund-ready list checkout', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });
    const env = {
      STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad',
      STRIPE_PRICE_PLUS_MONTHLY: 'price_cad_mo',
    };
    const now = new Date('2026-11-16T12:00:00-05:00');
    const checkoutEvent = {
      id: 'evt_list_cs',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_list',
          subscription: 'sub_bad',
          payment_link: 'plink_year',
          metadata: { familyId: FAMILY_ID, tier: 'plus', priceId: 'price_cad_mo' },
        },
      },
    };

    await applyStripeBillingEvent(
      checkoutEvent,
      db,
      MAP,
      {},
      {
        now,
        env,
        onDisallowedPrice: async () => 'sent',
      },
    );

    const later = await applyStripeBillingEvent(
      {
        id: 'evt_sub_later',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_bad',
            items: { data: [{ price: { id: PRICE_PLUS } }] },
            metadata: { familyId: FAMILY_ID },
          },
        },
      },
      db,
      MAP,
      {},
      { now, env },
    );

    expect(later).toEqual({ status: 'blocked' });
    expect(rec.planWrites).toEqual([]);
    expect(rec.audits.map((a) => a.actionTaken)).toEqual([
      'billing_refund_ready',
      'billing_grant_blocked',
    ]);
    expect(rec.audits[1]).toMatchObject({
      after: { stripeEventId: 'evt_sub_later', subscriptionId: 'sub_bad' },
    });
  });

  it('does not grant Plus on a later subscription_cycle invoice for a refund-ready subscription', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });
    const env = {
      STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad',
      STRIPE_PRICE_PLUS_MONTHLY: PRICE_PLUS,
    };
    await applyStripeBillingEvent(
      {
        id: 'evt_create',
        type: 'customer.subscription.created',
        data: {
          object: {
            id: 'sub_bad',
            items: { data: [{ price: { id: PRICE_PLUS } }] },
            metadata: { familyId: FAMILY_ID },
          },
        },
      },
      db,
      MAP,
      {},
      {
        now: new Date('2026-11-16T12:00:00-05:00'),
        env,
        onDisallowedPrice: async () => 'sent',
      },
    );

    const cycle = await applyStripeBillingEvent(
      {
        id: 'evt_cycle',
        type: 'invoice.paid',
        data: {
          object: {
            billing_reason: 'subscription_cycle',
            lines: { data: [{ price: { id: PRICE_PLUS } }] },
            parent: {
              subscription_details: {
                subscription: 'sub_bad',
                metadata: { familyId: FAMILY_ID },
              },
            },
          },
        },
      },
      db,
      MAP,
      {},
      { now: new Date('2026-11-16T12:00:00-05:00'), env },
    );

    expect(cycle).toEqual({ status: 'blocked' });
    expect(rec.planWrites).toEqual([]);
  });

  it('still grants Plus on a different subscription after a refund-ready marker', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });
    const env = {
      STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad',
      STRIPE_PRICE_PLUS_MONTHLY: PRICE_PLUS,
    };
    await applyStripeBillingEvent(
      {
        id: 'evt_bad',
        type: 'customer.subscription.created',
        data: {
          object: {
            id: 'sub_bad',
            items: { data: [{ price: { id: PRICE_PLUS } }] },
            metadata: { familyId: FAMILY_ID },
          },
        },
      },
      db,
      MAP,
      {},
      {
        now: new Date('2026-11-16T12:00:00-05:00'),
        env,
        onDisallowedPrice: async () => 'sent',
      },
    );

    const ok = await applyStripeBillingEvent(
      {
        id: 'evt_ok',
        type: 'customer.subscription.updated',
        data: {
          object: {
            id: 'sub_ok',
            items: { data: [{ price: { id: PRICE_FAMILY } }] },
            metadata: { familyId: FAMILY_ID },
          },
        },
      },
      db,
      MAP,
      {},
      { now: new Date('2026-11-16T12:00:00-05:00'), env },
    );

    expect(ok).toEqual({ status: 'applied', tier: 'family' });
    expect(rec.planWrites).toEqual([{ tier: 'family', stripeSubscriptionId: 'sub_ok' }]);
  });

  it('uses Stripe event.created, not receipt time, so a late webhook cannot reopen a list purchase', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });
    const created = Math.floor(new Date('2026-11-16T12:00:00-05:00').getTime() / 1000);
    const result = await applyStripeBillingEvent(
      {
        id: 'evt_late',
        type: 'checkout.session.completed',
        created,
        data: {
          object: {
            id: 'cs_late',
            payment_link: 'plink_year',
            metadata: { familyId: FAMILY_ID, tier: 'plus', priceId: 'price_cad_mo' },
          },
        },
      },
      db,
      MAP,
      {},
      {
        now: new Date('2027-01-02T12:00:00-05:00'),
        env: {
          STRIPE_PRICE_FOUNDING_ANNUAL_CAD: 'price_founding_cad',
          STRIPE_PRICE_PLUS_MONTHLY: 'price_cad_mo',
        },
        onDisallowedPrice: async () => 'sent',
      },
    );

    expect(result).toEqual({ status: 'refund_ready', opsAlert: 'sent' });
    expect(rec.planWrites).toEqual([]);
  });

  it('grants family from a Max promo yearly Checkout Session during the window', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });
    const map: PriceTierMap = { price_max_cad: 'family' };
    const result = await applyStripeBillingEvent(
      {
        id: 'evt_max',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_max',
            metadata: {
              familyId: FAMILY_ID,
              tier: 'family',
              priceId: 'price_max_cad',
            },
            client_reference_id: FAMILY_ID,
          },
        },
      },
      db,
      map,
      {},
      {
        now: new Date('2026-11-16T12:00:00-05:00'),
        env: {
          STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD: 'price_plus_cad',
          STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD: 'price_max_cad',
        },
      },
    );

    expect(result).toEqual({ status: 'applied', tier: 'family' });
    expect(rec.planWrites).toEqual([{ tier: 'family' }]);
  });
});
