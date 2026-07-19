import type { Database } from '@hale/db';
import { hasEntitlement, type PlanTier } from '@hale/types';
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
  planWrites: Array<{ tier: string }>;
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
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () =>
            familyExists && opts.existingTier ? [{ planTier: opts.existingTier }] : [],
        }),
      }),
    }),
    update: () => ({
      set: (v: { planTier: string }) => ({
        where: () => ({
          returning: async () => {
            if (!familyExists) return [];
            rec.planWrites.push({ tier: v.planTier });
            return [{ id: FAMILY_ID }];
          },
        }),
      }),
    }),
  };
  const db = { transaction: async (cb: (t: typeof tx) => unknown) => cb(tx) } as unknown as Database;
  return { db, rec };
}

describe('applyStripeBillingEvent', () => {
  it('applies a Plus checkout: writes plan_tier=plus + one audit row, and the tier grants L3', async () => {
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
    // write → entitlement: the tier the event wrote actually unlocks L3 autonomy.
    expect(hasEntitlement(result.status === 'applied' ? result.tier : 'free', 'autonomy_l3')).toBe(
      true,
    );
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
    expect(hasEntitlement('free', 'autonomy_l3')).toBe(false);
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
});
