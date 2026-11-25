import { createHmac, randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import type { PlanTier } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeStripe, createFakeStripe, stripeError } from '~/lib/testing/fake-stripe';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { billingRevokeUnresolvedSentence } from '~/lib/trail/verbs';
import { verifyStripeBillingSignature } from './stripe-billing';
import { type ApplyStripeBillingDeps, applyStripeBillingEvent } from './stripe-billing-apply.js';

/**
 * The follow-ups #1340 and #1350 left open, with both refund flags on: a partial refund,
 * and a refund Stripe later reports failed. Real Postgres, the real reader, the fake Stripe,
 * and events that pass the webhook's own signature check before they are applied.
 */

const FLAGS_OFF = { STRIPE_SECRET_KEY: 'sk_test_fixture' };
const FLAGS_ON = {
  ...FLAGS_OFF,
  STRIPE_BILLING_REVOKE_ENABLED: 'true',
  STRIPE_REFUND_ENDS_SUBSCRIPTION_ENABLED: 'true',
};
const TIERS = { price_plus: 'plus', price_max: 'family' } as const;
const WEBHOOK_SECRET = 'whsec_fixture';
const NOW = new Date('2026-11-20T12:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY = 86_400;
const BOUGHT = NOW_S - 30 * DAY;
const PRICE = 7900;

let db: TestDb;
let serial = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  vi.stubGlobal('fetch', () => {
    throw new Error('a test reached the global fetch');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The body Stripe would post, signed and checked by the route's own gate, then parsed. */
function signed(event: Record<string, unknown>): unknown {
  const body = JSON.stringify(event);
  const t = NOW_S;
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
  expect(verifyStripeBillingSignature(`t=${t},v1=${v1}`, body, WEBHOOK_SECRET, NOW_S)).toEqual({
    status: 'verified',
  });
  return JSON.parse(body);
}

function harness(env: Record<string, string> = FLAGS_ON) {
  const fake = createFakeStripe();
  const unresolved: Array<{ eventId: string; reason: string }> = [];
  const held: Array<{ eventId: string; reason: string }> = [];
  const pages: string[] = [];
  serial += 1;
  const deps: ApplyStripeBillingDeps = {
    env,
    now: NOW,
    stripeFetch: fake.fetch,
    onUnresolvedRevoke: async (info) => {
      unresolved.push(info);
      return 'sent';
    },
    onPlanUnsettled: async (info) => {
      held.push(info);
      return 'sent';
    },
    pageDeps: {
      post: async (text) => {
        pages.push(text);
        return 'sent';
      },
      now: new Date(NOW.getTime() + serial * 3_600_000),
    },
  };
  const apply = (event: Record<string, unknown>) =>
    applyStripeBillingEvent(signed(event), db.database, TIERS, {}, deps);
  return { fake, unresolved, held, pages, apply };
}

async function family(tier: PlanTier, suffix: string): Promise<string> {
  const { familyId } = await seedFamily(db.database, 'Refund follow-up family');
  await db.database
    .update(schema.families)
    .set({
      planTier: tier,
      stripeCustomerId: `cus_${suffix}`,
      stripeSubscriptionId: `sub_${suffix}`,
    })
    .where(eq(schema.families.id, familyId));
  return familyId;
}

function buy(fake: FakeStripe, suffix: string, familyId: string | null): void {
  fake.addSubscription({
    id: `sub_${suffix}`,
    customer: `cus_${suffix}`,
    familyId,
    created: BOUGHT,
    periodStart: BOUGHT,
    periodEnd: BOUGHT + 365 * DAY,
  });
  fake.addPaidInvoice({
    subscriptionId: `sub_${suffix}`,
    invoiceId: `in_${suffix}`,
    chargeId: `ch_${suffix}`,
    paymentIntentId: `pi_${suffix}`,
    periodStart: BOUGHT,
    periodEnd: BOUGHT + 365 * DAY,
    amount: PRICE,
  });
}

/** Part of the charge back, as Stripe records it: the charge is not marked refunded. */
function partialRefundEvent(fake: FakeStripe, chargeId: string, amount: number) {
  const charge = fake.charges.get(chargeId);
  if (!charge) throw new Error(`no ${chargeId}`);
  charge.amount_refunded += amount;
  fake.refunds.push({
    id: `re_partial_${fake.refunds.length + 1}`,
    object: 'refund',
    charge: chargeId,
    amount,
    status: 'succeeded',
    pending_reason: null,
  });
  return {
    id: `evt_partial_${serial}_${fake.refunds.length}`,
    type: 'charge.refunded',
    created: NOW_S - 60,
    data: { object: { ...charge } },
  };
}

function fullRefundEvent(fake: FakeStripe, chargeId: string) {
  fake.refund(chargeId);
  return {
    id: `evt_full_${serial}`,
    type: 'charge.refunded',
    created: NOW_S - 60,
    data: { object: { ...fake.charges.get(chargeId) } },
  };
}

/** Stripe's refund.failed: the refund object, which names its charge. */
function refundFailedEvent(fake: FakeStripe, chargeId: string) {
  const refund = fake.refunds.find((row) => row.charge === chargeId);
  if (!refund) throw new Error(`no refund on ${chargeId}`);
  refund.status = 'failed';
  return {
    id: `evt_refund_failed_${serial}`,
    type: 'refund.failed',
    created: NOW_S,
    data: {
      object: {
        id: refund.id,
        object: 'refund',
        amount: refund.amount,
        charge: chargeId,
        payment_intent: fake.charges.get(chargeId)?.payment_intent ?? null,
        status: 'failed',
        failure_reason: 'expired_or_canceled_card',
        metadata: {},
      },
    },
  };
}

async function planTier(familyId: string): Promise<string | undefined> {
  const [row] = await db.database
    .select({ planTier: schema.families.planTier })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return row?.planTier;
}

async function afters(familyId: string, verb: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, verb)));
  return rows.map((row) => row.after as Record<string, unknown>);
}

async function isClaimed(eventId: string): Promise<boolean> {
  const rows = await db.database
    .select({ id: schema.stripeBillingEvents.id })
    .from(schema.stripeBillingEvents)
    .where(eq(schema.stripeBillingEvents.eventId, eventId));
  return rows.length === 1;
}

describe('a partial refund never ends the plan or the subscription', () => {
  it('part of the current period back keeps the plan and the subscription, records which one, and pages nothing', async () => {
    const h = harness();
    const familyId = await family('plus', `ptied${serial}`);
    buy(h.fake, `ptied${serial}`, familyId);
    const event = partialRefundEvent(h.fake, `ch_ptied${serial}`, 1000);

    expect(await h.apply(event)).toEqual({ status: 'kept', reason: 'partial_refund' });
    expect(await planTier(familyId)).toBe('plus');
    expect(h.fake.deletes()).toEqual([]);
    expect(h.fake.subscriptions.get(`sub_ptied${serial}`)?.status).toBe('active');
    expect(await afters(familyId, 'billing_refunded')).toEqual([
      expect.objectContaining({
        reason: 'partial_refund',
        planTier: 'plus',
        tierChanged: false,
        stripeEventId: event.id,
        subscriptionId: `sub_ptied${serial}`,
      }),
    ]);
    expect(h.unresolved).toEqual([]);
    expect(h.held).toEqual([]);
    expect(h.pages).toEqual([]);
    expect(await isClaimed(event.id)).toBe(true);
    expect(await h.apply(event)).toEqual({ status: 'duplicate' });
    expect(await afters(familyId, 'billing_refunded')).toHaveLength(1);
  });

  it('a partial refund Hale cannot tie to a subscription is recorded and paged for review', async () => {
    const h = harness();
    const familyId = await family('plus', `puntied${serial}`);
    buy(h.fake, `puntied${serial}`, familyId);
    const charge = h.fake.charges.get(`ch_puntied${serial}`);
    if (!charge) throw new Error('fixture');
    charge.payment_intent = null;
    const event = partialRefundEvent(h.fake, `ch_puntied${serial}`, 1000);

    expect(await h.apply(event)).toEqual({
      status: 'unresolved',
      reason: 'partial_refund_unresolved',
      opsAlert: 'sent',
    });
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'partial_refund_unresolved' }]);
    expect(await planTier(familyId)).toBe('plus');
    expect(h.fake.deletes()).toEqual([]);
    expect(await afters(familyId, 'billing_revoke_unresolved')).toEqual([
      expect.objectContaining({
        reason: 'partial_refund_unresolved',
        stripeEventId: event.id,
        tierChanged: false,
      }),
    ]);
    expect(await isClaimed(event.id)).toBe(true);
    expect(await h.apply(event)).toEqual({ status: 'duplicate' });
    expect(h.unresolved).toHaveLength(1);
  });

  it('a partial refund naming a family Hale has erased pages no_family once', async () => {
    const h = harness();
    const suffix = `perased${serial}`;
    buy(h.fake, suffix, randomUUID());
    const event = partialRefundEvent(h.fake, `ch_${suffix}`, 1000);

    expect(await h.apply(event)).toEqual({
      status: 'unresolved',
      reason: 'no_family',
      opsAlert: 'sent',
    });
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'no_family' }]);
    expect(h.fake.deletes()).toEqual([]);
    expect(await isClaimed(event.id)).toBe(true);
    expect(await h.apply(event)).toEqual({ status: 'duplicate' });
    expect(h.unresolved).toHaveLength(1);
  });

  it('a Stripe refusal while reading a partial refund retries unclaimed, pages, and changes nothing', async () => {
    const h = harness();
    const familyId = await family('plus', `p403${serial}`);
    buy(h.fake, `p403${serial}`, familyId);
    h.fake.intercept(
      (call) => call.path === '/v1/invoice_payments',
      () => stripeError(403),
      1,
    );
    const event = partialRefundEvent(h.fake, `ch_p403${serial}`, 1000);

    expect(await h.apply(event)).toMatchObject({ status: 'retry', reason: 'stripe_refused' });
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toContain('billing_stripe_refused');
    expect(await isClaimed(event.id)).toBe(false);
    expect(await planTier(familyId)).toBe('plus');
    expect(await afters(familyId, 'billing_refunded')).toEqual([]);

    expect(await h.apply(event)).toEqual({ status: 'kept', reason: 'partial_refund' });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('positive control: the rest of the charge refunded later still ends the plan as #1340 designed', async () => {
    const h = harness();
    const suffix = `prest${serial}`;
    const familyId = await family('plus', suffix);
    buy(h.fake, suffix, familyId);

    expect(await h.apply(partialRefundEvent(h.fake, `ch_${suffix}`, 1000))).toEqual({
      status: 'kept',
      reason: 'partial_refund',
    });
    const charge = h.fake.charges.get(`ch_${suffix}`);
    if (!charge) throw new Error('fixture');
    charge.refunded = true;
    charge.amount_refunded = PRICE;
    h.fake.refunds.push({
      id: 're_rest',
      object: 'refund',
      charge: charge.id,
      amount: PRICE - 1000,
      status: 'succeeded',
      pending_reason: null,
    });
    const rest = {
      id: `evt_rest_${serial}`,
      type: 'charge.refunded',
      created: NOW_S - 30,
      data: { object: { ...charge } },
    };

    expect(await h.apply(rest)).toEqual({ status: 'applied', tier: 'free' });
    expect(h.fake.deletes()).toEqual([`sub_${suffix}`]);
    expect(await planTier(familyId)).toBe('free');
  });

  it('flags off: a partial refund is a no_tier, exactly as main', async () => {
    const h = harness(FLAGS_OFF);
    const familyId = await family('plus', `poff${serial}`);
    buy(h.fake, `poff${serial}`, familyId);
    const event = partialRefundEvent(h.fake, `ch_poff${serial}`, 1000);

    expect(await h.apply(event)).toEqual({ status: 'no_tier' });
    expect(h.fake.calls).toEqual([]);
    expect(await isClaimed(event.id)).toBe(false);
  });
});

describe('a refund Stripe later reports failed', () => {
  it('after a full refund ended the plan, it pages for a person, records one row, and is claimed', async () => {
    const h = harness();
    const suffix = `rfail${serial}`;
    const familyId = await family('plus', suffix);
    buy(h.fake, suffix, familyId);

    expect(await h.apply(fullRefundEvent(h.fake, `ch_${suffix}`))).toEqual({
      status: 'applied',
      tier: 'free',
    });
    expect(h.fake.deletes()).toEqual([`sub_${suffix}`]);

    const failed = refundFailedEvent(h.fake, `ch_${suffix}`);
    expect(await h.apply(failed)).toEqual({
      status: 'unresolved',
      reason: 'refund_failed',
      opsAlert: 'sent',
    });
    expect(h.unresolved).toEqual([{ eventId: failed.id, reason: 'refund_failed' }]);
    const [row] = await afters(familyId, 'billing_revoke_unresolved');
    expect(row).toMatchObject({ reason: 'refund_failed', stripeEventId: failed.id });
    expect(await afters(familyId, 'billing_revoke_unresolved')).toHaveLength(1);
    expect(await isClaimed(failed.id)).toBe(true);

    expect(await h.apply(failed)).toEqual({ status: 'duplicate' });
    expect(h.unresolved).toHaveLength(1);
  });

  it('the family history line names neither a refund nor a failure', () => {
    const sentence = billingRevokeUnresolvedSentence({ reason: 'refund_failed' });
    expect(sentence).toBe('a payment needs a second look, so the plan was left as it is');
    expect(billingRevokeUnresolvedSentence({ reason: 'subscription_unresolved' })).toBeNull();
  });

  it('a failed refund whose charge Stripe will not show retries unclaimed and pages', async () => {
    const h = harness();
    const suffix = `rfail403${serial}`;
    const familyId = await family('free', suffix);
    buy(h.fake, suffix, familyId);
    h.fake.refund(`ch_${suffix}`);
    const failed = refundFailedEvent(h.fake, `ch_${suffix}`);
    h.fake.intercept(
      (call) => call.path === `/v1/charges/ch_${suffix}`,
      () => stripeError(403),
      1,
    );

    expect(await h.apply(failed)).toMatchObject({ status: 'retry', reason: 'stripe_refused' });
    expect(await isClaimed(failed.id)).toBe(false);
    expect(h.pages).toHaveLength(1);
    expect(await afters(familyId, 'billing_revoke_unresolved')).toEqual([]);
  });

  it('flags off: refund.failed is a no_tier, exactly as main', async () => {
    const h = harness(FLAGS_OFF);
    const suffix = `rfailoff${serial}`;
    buy(h.fake, suffix, await family('free', suffix));
    h.fake.refund(`ch_${suffix}`);

    expect(await h.apply(refundFailedEvent(h.fake, `ch_${suffix}`))).toEqual({
      status: 'no_tier',
    });
    expect(h.fake.calls).toEqual([]);
  });
});
