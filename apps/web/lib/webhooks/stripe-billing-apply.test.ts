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

function checkout(eventId: string, priceId: string, familyId: string | null = FAMILY_ID) {
  const object: Record<string, unknown> = { price: { id: priceId } };
  if (familyId) object.client_reference_id = familyId;
  return { id: eventId, type: 'checkout.session.completed', data: { object } };
}

interface Recorder {
  planWrites: Array<{ tier: string }>;
  audits: Array<Record<string, unknown>>;
  claimed: Set<string>;
}

/**
 * Fake of the apply transaction: insert(stripe_billing_events).onConflictDoNothing()
 * .returning() yields [] for an already-claimed event id (the unique-index conflict)
 * and [{id}] for a fresh one; families update + audit insert are recorded.
 * `preClaimed` seeds event ids as already-processed (models a redelivery).
 */
function fakeDb(opts: { existingTier?: PlanTier; preClaimed?: string[] } = {}): {
  db: Database;
  rec: Recorder;
} {
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
          limit: async () => (opts.existingTier ? [{ planTier: opts.existingTier }] : []),
        }),
      }),
    }),
    update: () => ({
      set: (v: { planTier: string }) => ({
        where: async () => {
          rec.planWrites.push({ tier: v.planTier });
        },
      }),
    }),
  };
  const db = { transaction: async (cb: (t: typeof tx) => unknown) => cb(tx) } as unknown as Database;
  return { db, rec };
}

describe('applyStripeBillingEvent', () => {
  it('applies a Plus checkout: writes plan_tier=plus + one audit row, and the tier grants L3', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });

    const result = await applyStripeBillingEvent(checkout('evt_1', PRICE_PLUS), db, MAP);

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

    const result = await applyStripeBillingEvent(checkout('evt_1', PRICE_PLUS), db, MAP);

    expect(result).toEqual({ status: 'duplicate' });
    expect(rec.planWrites).toEqual([]);
    expect(rec.audits).toEqual([]);
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

  it('writes nothing for an unknown price id (no silent tier grant)', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });

    const result = await applyStripeBillingEvent(checkout('evt_2', 'price_unmapped'), db, MAP);

    expect(result).toEqual({ status: 'no_tier' });
    expect(rec.planWrites).toEqual([]);
    expect(rec.audits).toEqual([]);
  });

  it('writes nothing for an event with no family reference (unattributable)', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });

    const result = await applyStripeBillingEvent(checkout('evt_3', PRICE_PLUS, null), db, MAP);

    expect(result).toEqual({ status: 'unbound' });
    expect(rec.planWrites).toEqual([]);
  });

  it('ignores an event with no id (cannot be deduped)', async () => {
    const { db, rec } = fakeDb({ existingTier: 'free' });

    const result = await applyStripeBillingEvent(
      { type: 'checkout.session.completed', data: { object: { price: { id: PRICE_PLUS } } } },
      db,
      MAP,
    );

    expect(result).toEqual({ status: 'ignored' });
    expect(rec.planWrites).toEqual([]);
  });
});
