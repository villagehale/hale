import { schema } from '@hale/db';
import { MAX_ENTITLEMENTS, PLUS_ENTITLEMENTS, entitlementsFor } from '@hale/types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billingWebhookReady, reconcileBillingTiers } from '~/lib/billing/billing-live';
import type {
  OtherSubscriptions,
  StripeChargeContext,
  StripeChargeLookup,
} from '~/lib/billing/stripe-charge-context';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { applyStripeBillingEvent } from './stripe-billing-apply.js';

/**
 * VIL-703. A full refund or a dispute on a cancelled Max subscription drops
 * the tier. A partial refund and a replay do not. Checkout stays closed until
 * a signed event has been claimed.
 */

const REVOKE = { STRIPE_BILLING_REVOKE_ENABLED: 'true' };

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function planTier(familyId: string): Promise<string | undefined> {
  const [row] = await db.database
    .select({ planTier: schema.families.planTier })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  return row?.planTier;
}

const NOTHING_ELSE: OtherSubscriptions = { paid: [], refundedIds: [], truncated: false };

function lookupFake(
  found: Partial<StripeChargeContext> = {},
  other: OtherSubscriptions = NOTHING_ELSE,
): StripeChargeLookup {
  return {
    async lookupCharge() {
      return {
        customerId: null,
        subscriptionId: null,
        subscriptionStatus: null,
        subscriptionCreated: null,
        subscriptionCustomerId: null,
        subscriptionFamilyId: null,
        familyId: null,
        periodStanding: null,
        ...found,
      };
    },
    async subscriptionStatus() {
      return 'canceled';
    },
    async otherSubscriptions() {
      return other;
    },
  };
}

function refund(input: {
  id: string;
  familyId: string;
  amount: number;
  amountRefunded: number;
  refunded: boolean;
  status?: string;
}) {
  return {
    id: input.id,
    type: 'charge.refunded',
    data: {
      object: {
        amount: input.amount,
        amount_refunded: input.amountRefunded,
        refunded: input.refunded,
        customer: 'cus_max',
        metadata: { familyId: input.familyId },
        invoice: {
          subscription: { id: 'sub_max', status: input.status ?? 'canceled' },
        },
      },
    },
  };
}

describe('stripe billing revoke', () => {
  it('drops a cancelled Max subscription to free on a full refund, and a replay does nothing', async () => {
    const { familyId } = await seedFamily(db.database, 'Max family');
    await db.database
      .update(schema.families)
      .set({ planTier: 'family', stripeCustomerId: 'cus_max', stripeSubscriptionId: 'sub_max' })
      .where(eq(schema.families.id, familyId));

    const event = refund({
      id: 'evt_full',
      familyId,
      amount: 7900,
      amountRefunded: 7900,
      refunded: true,
      status: 'canceled',
    });
    const deps = { env: REVOKE, chargeLookup: lookupFake() };
    const first = await applyStripeBillingEvent(event, db.database, {}, {}, deps);
    expect(first).toEqual({ status: 'applied', tier: 'free' });
    expect(await planTier(familyId)).toBe('free');
    expect(entitlementsFor('free', true)).toEqual(PLUS_ENTITLEMENTS);
    expect(entitlementsFor('free', true)).not.toEqual(MAX_ENTITLEMENTS);

    const replay = await applyStripeBillingEvent(event, db.database, {}, {}, deps);
    expect(replay).toEqual({ status: 'duplicate' });
    expect(await planTier(familyId)).toBe('free');
  });

  it('leaves the tier in place on a partial refund', async () => {
    const { familyId } = await seedFamily(db.database, 'Partial family');
    await db.database
      .update(schema.families)
      .set({
        planTier: 'family',
        stripeCustomerId: 'cus_partial',
        stripeSubscriptionId: 'sub_partial',
      })
      .where(eq(schema.families.id, familyId));

    const result = await applyStripeBillingEvent(
      refund({
        id: 'evt_partial',
        familyId,
        amount: 7900,
        amountRefunded: 500,
        refunded: false,
        status: 'canceled',
      }),
      db.database,
      {},
      {},
      { env: REVOKE },
    );
    expect(result).toEqual({ status: 'kept', reason: 'partial_refund' });
    expect(await planTier(familyId)).toBe('family');
    expect(entitlementsFor('family', true)).toEqual(MAX_ENTITLEMENTS);
  });

  it('revokes on a dispute and on subscription.deleted, and grants Max from metadata.tier Max', async () => {
    const { familyId } = await seedFamily(db.database, 'Dispute family');
    const granted = await applyStripeBillingEvent(
      {
        id: 'evt_max_checkout',
        type: 'checkout.session.completed',
        data: { object: { metadata: { tier: 'Max', familyId } } },
      },
      db.database,
    );
    expect(granted).toEqual({ status: 'applied', tier: 'family' });
    expect(entitlementsFor('family', true)).toEqual(MAX_ENTITLEMENTS);

    await db.database
      .update(schema.families)
      .set({ stripeCustomerId: 'cus_dispute', stripeSubscriptionId: 'sub_dispute' })
      .where(eq(schema.families.id, familyId));

    const dispute = await applyStripeBillingEvent(
      {
        id: 'evt_dispute',
        type: 'charge.dispute.created',
        data: {
          object: {
            customer: 'cus_dispute',
            metadata: { familyId },
            subscription: { id: 'sub_dispute', status: 'canceled' },
          },
        },
      },
      db.database,
      {},
      {},
      { env: REVOKE, chargeLookup: lookupFake() },
    );
    expect(dispute).toEqual({ status: 'applied', tier: 'free' });
    expect(await planTier(familyId)).toBe('free');

    await db.database
      .update(schema.families)
      .set({ planTier: 'family' })
      .where(eq(schema.families.id, familyId));
    const deleted = await applyStripeBillingEvent(
      {
        id: 'evt_deleted',
        type: 'customer.subscription.deleted',
        data: { object: { id: 'sub_dispute', metadata: { familyId } } },
      },
      db.database,
    );
    expect(deleted).toEqual({ status: 'applied', tier: 'free' });
    expect(await planTier(familyId)).toBe('free');
  });

  it('keeps the tier when a different live subscription remains', async () => {
    const { familyId } = await seedFamily(db.database, 'Second sub');
    await db.database
      .update(schema.families)
      .set({ planTier: 'plus', stripeCustomerId: 'cus_two', stripeSubscriptionId: 'sub_live' })
      .where(eq(schema.families.id, familyId));

    const result = await applyStripeBillingEvent(
      {
        id: 'evt_other_sub',
        type: 'charge.refunded',
        data: {
          object: {
            amount: 1400,
            amount_refunded: 1400,
            refunded: true,
            metadata: { familyId },
            invoice: { subscription: { id: 'sub_old', status: 'canceled' } },
          },
        },
      },
      db.database,
      {},
      {},
      {
        env: REVOKE,
        chargeLookup: lookupFake(
          {},
          { paid: [{ id: 'sub_live', priceId: null }], refundedIds: [], truncated: false },
        ),
      },
    );
    expect(result).toEqual({ status: 'kept', reason: 'active_subscription' });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('does not drop a newer subscription when the refunded invoice is only an id', async () => {
    const { familyId } = await seedFamily(db.database, 'Newer sub');
    await db.database
      .update(schema.families)
      .set({ planTier: 'family', stripeCustomerId: 'cus_newer', stripeSubscriptionId: 'sub_new' })
      .where(eq(schema.families.id, familyId));

    const bare = await applyStripeBillingEvent(
      {
        id: 'evt_bare_invoice',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_old',
            amount: 7900,
            amount_refunded: 7900,
            refunded: true,
            customer: 'cus_newer',
            invoice: 'in_old',
            metadata: { familyId },
          },
        },
      },
      db.database,
      {},
      {},
      { env: REVOKE, chargeLookup: lookupFake() },
    );
    expect(bare).toMatchObject({ status: 'unresolved', reason: 'subscription_unresolved' });
    expect(await planTier(familyId)).toBe('family');

    const lookedUp = await applyStripeBillingEvent(
      {
        id: 'evt_looked_up',
        type: 'charge.refunded',
        data: {
          object: {
            id: 'ch_old',
            amount: 7900,
            amount_refunded: 7900,
            refunded: true,
            customer: 'cus_newer',
            invoice: 'in_old',
          },
        },
      },
      db.database,
      {},
      {},
      {
        env: REVOKE,
        chargeLookup: lookupFake(
          { customerId: 'cus_newer', subscriptionId: 'sub_old', subscriptionStatus: 'canceled' },
          { paid: [{ id: 'sub_new', priceId: null }], refundedIds: [], truncated: false },
        ),
      },
    );
    expect(lookedUp).toEqual({ status: 'kept', reason: 'active_subscription' });
    expect(await planTier(familyId)).toBe('family');
    const counted = await reconcileBillingTiers(db.database, REVOKE);
    expect(counted).toMatchObject({
      status: 'checked',
      mismatches: { revokeUnresolved: 1 },
    });
    await db.database
      .update(schema.families)
      .set({ planTier: 'free' })
      .where(eq(schema.families.id, familyId));
  });

  it('revokes a dispute after the charge is resolved to the cancelled subscription', async () => {
    const { familyId } = await seedFamily(db.database, 'Dispute lookup');
    await db.database
      .update(schema.families)
      .set({
        planTier: 'family',
        stripeCustomerId: 'cus_dlookup',
        stripeSubscriptionId: 'sub_dlookup',
      })
      .where(eq(schema.families.id, familyId));

    const unresolved = await applyStripeBillingEvent(
      {
        id: 'evt_dispute_bare',
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_bare', charge: 'ch_bare' } },
      },
      db.database,
      {},
      {},
      { env: REVOKE, chargeLookup: lookupFake() },
    );
    expect(unresolved).toMatchObject({ status: 'unresolved', reason: 'no_family' });
    expect(await planTier(familyId)).toBe('family');

    const resolved = await applyStripeBillingEvent(
      {
        id: 'evt_dispute_resolved',
        type: 'charge.dispute.created',
        data: { object: { id: 'dp_1', charge: 'ch_1' } },
      },
      db.database,
      {},
      {},
      {
        env: REVOKE,
        chargeLookup: lookupFake({
          customerId: 'cus_dlookup',
          subscriptionId: 'sub_dlookup',
          subscriptionStatus: 'canceled',
          familyId,
        }),
      },
    );
    expect(resolved).toEqual({ status: 'applied', tier: 'free' });
    expect(await planTier(familyId)).toBe('free');
  });

  it('does not revoke while STRIPE_BILLING_REVOKE_ENABLED is off', async () => {
    const { familyId } = await seedFamily(db.database, 'Flag off');
    await db.database
      .update(schema.families)
      .set({ planTier: 'family', stripeCustomerId: 'cus_off', stripeSubscriptionId: 'sub_off' })
      .where(eq(schema.families.id, familyId));
    const result = await applyStripeBillingEvent(
      refund({
        id: 'evt_flag_off',
        familyId,
        amount: 7900,
        amountRefunded: 7900,
        refunded: true,
      }),
      db.database,
      {},
      {},
      { env: {} },
    );
    expect(result).toEqual({ status: 'no_tier' });
    expect(await planTier(familyId)).toBe('family');
  });
});

describe('billing webhook gate and reconcile', () => {
  it('refuses checkout until a signed event has been applied and the secret is set', async () => {
    expect(
      await billingWebhookReady(db.database, {
        STRIPE_BILLING_REVOKE_ENABLED: 'true',
        STRIPE_WEBHOOK_SECRET: 'whsec_test',
      }),
    ).toEqual({ ready: true });

    const empty = await createTestDb();
    try {
      expect(
        await billingWebhookReady(empty.database, {
          STRIPE_BILLING_REVOKE_ENABLED: 'true',
          STRIPE_WEBHOOK_SECRET: 'whsec_test',
        }),
      ).toEqual({ ready: false, reason: 'no_applied_event' });
      await empty.database.insert(schema.stripeBillingEvents).values({ eventId: 'evt_claim_only' });
      expect(
        await billingWebhookReady(empty.database, {
          STRIPE_BILLING_REVOKE_ENABLED: 'true',
          STRIPE_WEBHOOK_SECRET: 'whsec_test',
        }),
      ).toEqual({ ready: false, reason: 'no_applied_event' });
      const { familyId } = await seedFamily(empty.database, 'Applied grant');
      await empty.database.insert(schema.auditLog).values({
        familyId,
        actor: 'system',
        actionTaken: 'family_plan_updated',
        targetTable: 'families',
        targetId: familyId,
        after: { planTier: 'plus', source: 'stripe', stripeEventId: 'evt_applied' },
      });
      expect(
        await billingWebhookReady(empty.database, {
          STRIPE_BILLING_REVOKE_ENABLED: 'true',
          STRIPE_WEBHOOK_SECRET: 'whsec_test',
        }),
      ).toEqual({ ready: true });
      expect(
        await billingWebhookReady(empty.database, { STRIPE_BILLING_REVOKE_ENABLED: 'true' }),
      ).toEqual({ ready: false, reason: 'secret_unset' });
      expect(await billingWebhookReady(empty.database, {})).toEqual({ ready: true });
    } finally {
      await empty.close();
    }
  });

  it('pages when a paid grant is sitting on free, and is quiet when they match', async () => {
    const quiet = await reconcileBillingTiers(db.database, REVOKE);
    expect(quiet).toMatchObject({ status: 'checked', opsAlert: 'not_needed' });

    const { familyId } = await seedFamily(db.database, 'Mismatch');
    await db.database
      .update(schema.families)
      .set({ planTier: 'free', stripeCustomerId: 'cus_mismatch' })
      .where(eq(schema.families.id, familyId));
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'family_plan_updated',
      targetTable: 'families',
      targetId: familyId,
      after: { planTier: 'family', source: 'stripe', stripeEventId: 'evt_old' },
    });

    const previous = process.env.OPS_SLACK_WEBHOOK_URL;
    process.env.OPS_SLACK_WEBHOOK_URL = 'https://hooks.slack.com/services/test';
    const fetchImpl = async () => new Response('ok', { status: 200 });
    try {
      const paged = await reconcileBillingTiers(db.database, REVOKE, fetchImpl);
      expect(paged).toMatchObject({
        status: 'checked',
        mismatches: { freeDespitePaid: 1 },
        opsAlert: 'sent',
      });
    } finally {
      process.env.OPS_SLACK_WEBHOOK_URL = previous;
    }

    expect(await reconcileBillingTiers(db.database, {})).toEqual({ status: 'flag_off' });
  });
});
