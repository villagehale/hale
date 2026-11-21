import { schema } from '@hale/db';
import type { PlanTier } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FakeStripe, createFakeStripe, stripeError } from '~/lib/testing/fake-stripe';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { type ApplyStripeBillingDeps, applyStripeBillingEvent } from './stripe-billing-apply.js';
import type { PriceTierMap } from './stripe-billing.js';

/**
 * A full refund, read through the real Stripe lookup over a fixture of Stripe's
 * documented objects, against real Postgres. Stripe is an in-memory fake that throws on
 * anything it does not model, and the global fetch throws too, so a dependency left out
 * fails the test instead of reaching the network.
 */

const FLAG_OFF = { STRIPE_BILLING_REVOKE_ENABLED: 'true', STRIPE_SECRET_KEY: 'sk_test_fixture' };
const FLAG_ON = { ...FLAG_OFF, STRIPE_REFUND_ENDS_SUBSCRIPTION_ENABLED: 'true' };
const TIERS: PriceTierMap = { price_plus: 'plus', price_max: 'family' };

const NOW = new Date('2026-11-20T12:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY = 86_400;
const HOUR_MS = 3_600_000;
const BOUGHT = NOW_S - 30 * DAY;

type Env = Record<string, string>;

let db: TestDb;
let eventCounter = 0;
/** ops:page dedupes per site and hour in the shared database, so each harness gets an hour. */
let pageHour = 0;

function nextEventId(label: string): string {
  eventCounter += 1;
  return `evt_${label}_${eventCounter}`;
}

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubGlobal('fetch', () => {
    throw new Error('a test reached the global fetch');
  });
  // Stored Stripe ids are unique across families, and fixtures reuse them between tests.
  await db.database
    .update(schema.families)
    .set({ stripeCustomerId: null, stripeSubscriptionId: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function harness(env: Env) {
  const fake = createFakeStripe();
  const unresolved: Array<{ eventId: string; reason: string }> = [];
  const refusedPages: string[] = [];
  pageHour += 1;
  const pageNow = new Date(NOW.getTime() + pageHour * HOUR_MS);
  const deps = (over: Partial<ApplyStripeBillingDeps> = {}): ApplyStripeBillingDeps => ({
    env,
    now: NOW,
    stripeFetch: fake.fetch,
    onUnresolvedRevoke: async (info) => {
      unresolved.push(info);
      return 'sent';
    },
    pageDeps: {
      post: async (text) => {
        refusedPages.push(text);
        return 'sent';
      },
      now: pageNow,
    },
    ...over,
  });
  const apply = (event: unknown, over?: Partial<ApplyStripeBillingDeps>) =>
    applyStripeBillingEvent(event, db.database, TIERS, {}, deps(over));
  return { fake, unresolved, refusedPages, deps, apply };
}

async function paidFamily(
  tier: PlanTier,
  customer: string | null,
  subscription: string | null,
): Promise<string> {
  const { familyId } = await seedFamily(db.database, 'Refund family');
  await db.database
    .update(schema.families)
    .set({ planTier: tier, stripeCustomerId: customer, stripeSubscriptionId: subscription })
    .where(eq(schema.families.id, familyId));
  return familyId;
}

function buy(
  fake: FakeStripe,
  suffix: string,
  familyId: string,
  over: { customer?: string; status?: string; created?: number; priceId?: string } = {},
): void {
  const created = over.created ?? BOUGHT;
  fake.addSubscription({
    id: `sub_${suffix}`,
    customer: over.customer ?? `cus_${suffix}`,
    familyId,
    status: over.status ?? 'active',
    created,
    periodStart: created,
    periodEnd: created + 365 * DAY,
    priceId: over.priceId ?? 'price_plus',
  });
  fake.addPaidInvoice({
    subscriptionId: `sub_${suffix}`,
    invoiceId: `in_${suffix}`,
    chargeId: `ch_${suffix}`,
    paymentIntentId: `pi_${suffix}`,
    periodStart: created,
    periodEnd: created + 365 * DAY,
  });
}

/** The webhook's charge.refunded payload at this API version: no invoice, no subscription. */
function refundEvent(fake: FakeStripe, chargeId: string, label = 'refund') {
  fake.refund(chargeId);
  return {
    id: nextEventId(label),
    type: 'charge.refunded',
    created: BOUGHT + DAY,
    data: { object: { ...fake.charges.get(chargeId) } },
  };
}

function disputeEvent(chargeId: string) {
  return {
    id: nextEventId('dispute'),
    type: 'charge.dispute.created',
    created: BOUGHT + DAY,
    data: { object: { id: `dp_${chargeId}`, object: 'dispute', charge: chargeId } },
  };
}

function deletedEvent(fake: FakeStripe, subscriptionId: string) {
  const subscription = fake.subscriptions.get(subscriptionId);
  if (!subscription) throw new Error(`no ${subscriptionId}`);
  subscription.status = 'canceled';
  return {
    id: nextEventId('deleted'),
    type: 'customer.subscription.deleted',
    created: NOW_S,
    data: { object: { ...subscription } },
  };
}

function subscriptionUpdatedEvent(
  fake: FakeStripe,
  subscriptionId: string,
  over: Record<string, unknown> = {},
) {
  const subscription = fake.subscriptions.get(subscriptionId);
  if (!subscription) throw new Error(`no ${subscriptionId}`);
  return {
    id: nextEventId('updated'),
    type: 'customer.subscription.updated',
    created: NOW_S,
    data: { object: { ...subscription, status: 'active', ...over } },
  };
}

/** Stripe advancing a subscription into its next period and collecting the invoice. */
function addRenewal(fake: FakeStripe, subscriptionId: string): string {
  const item = fake.subscriptions.get(subscriptionId)?.items.data[0];
  if (!item) throw new Error(`no ${subscriptionId}`);
  const periodStart = item.current_period_end;
  const periodEnd = periodStart + 365 * DAY;
  item.current_period_start = periodStart;
  item.current_period_end = periodEnd;
  const invoiceId = `in_renewal_${subscriptionId}`;
  fake.addPaidInvoice({
    subscriptionId,
    invoiceId,
    chargeId: `ch_renewal_${subscriptionId}`,
    paymentIntentId: `pi_renewal_${subscriptionId}`,
    periodStart,
    periodEnd,
    billingReason: 'subscription_cycle',
  });
  return invoiceId;
}

function paidEventFor(fake: FakeStripe, invoiceId: string, over: Record<string, unknown> = {}) {
  const invoice = fake.invoices.get(invoiceId);
  if (!invoice) throw new Error(`no ${invoiceId}`);
  return {
    id: nextEventId('invoice_paid'),
    type: 'invoice.paid',
    created: NOW_S,
    data: { object: { ...invoice, ...over } },
  };
}

function invoicePaidEvent(familyId: string, subscriptionId: string) {
  return {
    id: nextEventId('invoice_paid'),
    type: 'invoice.paid',
    created: NOW_S,
    data: {
      object: {
        id: `in_late_${subscriptionId}`,
        object: 'invoice',
        customer: `cus_${subscriptionId}`,
        billing_reason: 'subscription_cycle',
        parent: {
          type: 'subscription_details',
          subscription_details: { subscription: subscriptionId, metadata: { familyId } },
        },
        lines: {
          data: [{ pricing: { type: 'price_details', price_details: { price: 'price_plus' } } }],
        },
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

async function auditRows(familyId: string, verb?: string) {
  const rows = await db.database
    .select({ actionTaken: schema.auditLog.actionTaken, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      verb
        ? and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, verb))
        : eq(schema.auditLog.familyId, familyId),
    );
  return rows;
}

async function verbs(familyId: string): Promise<string[]> {
  return (await auditRows(familyId)).map((row) => row.actionTaken).sort();
}

async function claimed(eventId: string): Promise<boolean> {
  const rows = await db.database
    .select({ id: schema.stripeBillingEvents.id })
    .from(schema.stripeBillingEvents)
    .where(eq(schema.stripeBillingEvents.eventId, eventId));
  return rows.length === 1;
}

function statuses(fake: FakeStripe): string[] {
  return [...fake.subscriptions.values()].map((row) => row.status);
}

describe('the production bug: charge.refunded with no invoice on the charge', () => {
  it('flag off: a live subscription is kept, the event is claimed, and nobody is paged', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_live', 'sub_live');
    buy(h.fake, 'live', familyId);
    const event = refundEvent(h.fake, 'ch_live');
    expect(event.data.object).not.toHaveProperty('invoice');

    await expect(h.apply(event)).resolves.toEqual({
      status: 'kept',
      reason: 'active_subscription',
    });

    expect(await claimed(event.id)).toBe(true);
    expect(await planTier(familyId)).toBe('plus');
    expect(await verbs(familyId)).toEqual(['billing_refunded']);
    const [row] = await auditRows(familyId, 'billing_refunded');
    expect(row?.after).toMatchObject({
      source: 'stripe',
      stripeEventId: event.id,
      reason: 'active_subscription',
      tierChanged: false,
    });
    expect(h.unresolved).toEqual([]);
    expect(h.refusedPages).toEqual([]);
    expect(h.fake.deletes()).toEqual([]);
  });

  it('flag off: a proven ended subscription with nothing else paid drops, and Stripe is not written', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_ended', 'sub_ended');
    buy(h.fake, 'ended', familyId, { status: 'canceled' });
    const event = refundEvent(h.fake, 'ch_ended');

    await expect(h.apply(event)).resolves.toEqual({ status: 'applied', tier: 'free' });

    expect(await planTier(familyId)).toBe('free');
    expect(await claimed(event.id)).toBe(true);
    expect(h.fake.deletes()).toEqual([]);
    expect(await auditRows(familyId, 'billing_subscription_ended')).toEqual([]);
  });

  it('flag off: a stored id naming another ended subscription stays unresolved', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_stale', 'sub_elsewhere');
    buy(h.fake, 'stale', familyId, { status: 'canceled' });

    await expect(h.apply(refundEvent(h.fake, 'ch_stale'))).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'subscription_unresolved',
    });
    expect(await planTier(familyId)).toBe('plus');
    expect(h.fake.deletes()).toEqual([]);
  });

  it('claims a charge that names a family we do not have', async () => {
    const h = harness(FLAG_OFF);
    const ghost = '99999999-9999-4999-8999-999999999999';
    buy(h.fake, 'ghost', ghost);
    const event = refundEvent(h.fake, 'ch_ghost');

    await expect(h.apply(event)).resolves.toEqual({ status: 'unknown_family' });
    expect(await claimed(event.id)).toBe(true);
    expect(h.unresolved).toEqual([]);
  });
});

describe('flag on: a full refund of the current period ends the plan', () => {
  it('cancels the subscription, drops to free, writes the marker, and a replay does nothing', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_cur', 'sub_cur');
    buy(h.fake, 'cur', familyId);
    const event = refundEvent(h.fake, 'ch_cur');

    await expect(h.apply(event)).resolves.toEqual({ status: 'applied', tier: 'free' });

    expect(h.fake.deletes()).toEqual(['sub_cur']);
    expect(await planTier(familyId)).toBe('free');
    expect(await claimed(event.id)).toBe(true);
    expect(await verbs(familyId)).toEqual(['billing_subscription_ended', 'family_plan_updated']);
    const [marker] = await auditRows(familyId, 'billing_subscription_ended');
    expect(marker?.after).toEqual({
      source: 'stripe',
      stripeEventId: event.id,
      subscriptionId: 'sub_cur',
      reason: 'refund',
      tierChanged: true,
    });

    const before = h.fake.calls.length;
    await expect(h.apply(event)).resolves.toEqual({ status: 'duplicate' });
    expect(h.fake.calls.length).toBe(before);
    expect(h.fake.deletes()).toEqual(['sub_cur']);
  });

  it('keeps the plan on a refund of an older invoice', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_old', 'sub_old');
    buy(h.fake, 'old', familyId);
    h.fake.addPaidInvoice({
      subscriptionId: 'sub_old',
      invoiceId: 'in_prior',
      chargeId: 'ch_prior',
      paymentIntentId: 'pi_prior',
      periodStart: BOUGHT - 365 * DAY,
      periodEnd: BOUGHT,
      billingReason: 'subscription_cycle',
      latest: false,
    });
    const event = refundEvent(h.fake, 'ch_prior');

    await expect(h.apply(event)).resolves.toEqual({ status: 'kept', reason: 'older_invoice' });

    expect(h.fake.deletes()).toEqual([]);
    expect(await planTier(familyId)).toBe('plus');
    expect(await claimed(event.id)).toBe(true);
  });
});

describe('state C: a refunded duplicate never drops the plan the family still pays for', () => {
  describe.each([
    ['flag on', FLAG_ON],
    ['flag off', FLAG_OFF],
  ])('%s', (_name, env) => {
    it.each([
      ['the stored one, still active', 'b', 'active'],
      ['the stored one, already cancelled', 'b', 'canceled'],
      ['the unstored one, still active', 'a', 'active'],
      ['the unstored one, already cancelled', 'a', 'canceled'],
    ])('refunding %s on a second customer keeps the plan', async (_label, target, status) => {
      const h = harness(env);
      const familyId = await paidFamily('plus', 'cus_b', 'sub_b');
      buy(h.fake, 'a', familyId, { customer: 'cus_a' });
      buy(h.fake, 'b', familyId, { customer: 'cus_b' });
      const refunded = h.fake.subscriptions.get(`sub_${target}`);
      if (!refunded) throw new Error('no subscription');
      refunded.status = status;

      const result = await h.apply(refundEvent(h.fake, `ch_${target}`));

      expect(result.status).toBe('kept');
      expect(await planTier(familyId)).toBe('plus');
      expect(h.fake.deletes()).toEqual([]);
      expect(h.unresolved).toEqual([]);
    });

    it('holds when both sit on one customer', async () => {
      const h = harness(env);
      const familyId = await paidFamily('plus', 'cus_one', 'sub_b');
      buy(h.fake, 'a', familyId, { customer: 'cus_one' });
      buy(h.fake, 'b', familyId, { customer: 'cus_one' });
      h.fake.unindexed.add('sub_a');

      const result = await h.apply(refundEvent(h.fake, 'ch_b'));

      expect(result.status).toBe('kept');
      expect(await planTier(familyId)).toBe('plus');
      expect(h.fake.deletes()).toEqual([]);
    });
  });

  it('positive control: with search blind to the sibling, the same refund cancels and drops', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_b', 'sub_b');
    buy(h.fake, 'a', familyId, { customer: 'cus_a' });
    buy(h.fake, 'b', familyId, { customer: 'cus_b' });
    h.fake.unindexed.add('sub_a');

    await expect(h.apply(refundEvent(h.fake, 'ch_b'))).resolves.toEqual({
      status: 'applied',
      tier: 'free',
    });
    expect(h.fake.deletes()).toEqual(['sub_b']);
    expect(await planTier(familyId)).toBe('free');
  });
});

describe('a subscription too young for the search index waits', () => {
  it('retries without a cancel, a claim or a page, and the first delivery past the hour decides', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_new', 'sub_new');
    const created = NOW_S - 600;
    buy(h.fake, 'new', familyId, { created });
    const event = refundEvent(h.fake, 'ch_new');

    await expect(h.apply(event)).resolves.toEqual({ status: 'retry', reason: 'search_settling' });
    expect(h.fake.deletes()).toEqual([]);
    expect(await claimed(event.id)).toBe(false);
    expect(await planTier(familyId)).toBe('plus');
    expect(h.unresolved).toEqual([]);
    expect(h.refusedPages).toEqual([]);

    const later = new Date(NOW.getTime() + 2 * HOUR_MS);
    await expect(h.apply(event, { now: later })).resolves.toEqual({
      status: 'applied',
      tier: 'free',
    });
    expect(h.fake.deletes()).toEqual(['sub_new']);
  });
});

describe('both duplicates refunded', () => {
  it.each([
    ['a then b', 'a', 'b'],
    ['b then a', 'b', 'a'],
  ])('%s: the first keeps the plan, the last cancels both', async (_name, first, last) => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_b', 'sub_b');
    buy(h.fake, 'a', familyId, { customer: 'cus_a' });
    buy(h.fake, 'b', familyId, { customer: 'cus_b' });

    await expect(h.apply(refundEvent(h.fake, `ch_${first}`))).resolves.toEqual({
      status: 'kept',
      reason: 'duplicate_subscription',
    });
    expect(h.fake.deletes()).toEqual([]);
    expect(await planTier(familyId)).toBe('plus');

    await expect(h.apply(refundEvent(h.fake, `ch_${last}`))).resolves.toEqual({
      status: 'applied',
      tier: 'free',
    });
    expect(h.fake.deletes().sort()).toEqual(['sub_a', 'sub_b']);
    expect(statuses(h.fake)).toEqual(['canceled', 'canceled']);
    expect(await planTier(familyId)).toBe('free');
    const markers = await auditRows(familyId, 'billing_subscription_ended');
    expect(
      markers.map((row) => (row.after as { subscriptionId: string }).subscriptionId).sort(),
    ).toEqual(['sub_a', 'sub_b']);
  });
});

describe('a refunded duplicate never moves the plan', () => {
  it('flag on: a survivor on another tier keeps the plan, writes no tier, and pages', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('family', 'cus_max', 'sub_max');
    buy(h.fake, 'max', familyId, { priceId: 'price_max' });
    buy(h.fake, 'plus', familyId, { priceId: 'price_plus' });
    const event = refundEvent(h.fake, 'ch_max');

    await expect(h.apply(event)).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'surviving_plan_differs',
    });

    expect(await planTier(familyId)).toBe('family');
    expect(await auditRows(familyId, 'family_plan_updated')).toEqual([]);
    expect(h.fake.deletes()).toEqual([]);
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'surviving_plan_differs' }]);
    expect(await claimed(event.id)).toBe(true);
  });

  it('flag on: a survivor on the same tier keeps the plan with no page', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_one', 'sub_one');
    buy(h.fake, 'one', familyId, { priceId: 'price_plus' });
    buy(h.fake, 'two', familyId, { priceId: 'price_plus' });

    await expect(h.apply(refundEvent(h.fake, 'ch_one'))).resolves.toEqual({
      status: 'kept',
      reason: 'duplicate_subscription',
    });
    expect(await planTier(familyId)).toBe('plus');
    expect(h.unresolved).toEqual([]);
  });

  it('flag on: an unmapped survivor keeps the plan and pages', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('family', 'cus_max', 'sub_max');
    buy(h.fake, 'max', familyId, { priceId: 'price_max' });
    buy(h.fake, 'x', familyId, { priceId: 'price_unmapped' });
    const event = refundEvent(h.fake, 'ch_max');

    await expect(h.apply(event)).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'surviving_plan_differs',
    });
    expect(await planTier(familyId)).toBe('family');
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'surviving_plan_differs' }]);
    expect(await claimed(event.id)).toBe(true);
  });

  it('flag off: no tier write and no page', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('family', 'cus_max', 'sub_max');
    buy(h.fake, 'max', familyId, { priceId: 'price_max', status: 'canceled' });
    buy(h.fake, 'plus', familyId, { priceId: 'price_plus' });

    await expect(h.apply(refundEvent(h.fake, 'ch_max'))).resolves.toEqual({
      status: 'kept',
      reason: 'active_subscription',
    });

    expect(await planTier(familyId)).toBe('family');
    expect(await auditRows(familyId, 'family_plan_updated')).toEqual([]);
    expect(h.unresolved).toEqual([]);
  });
});

describe('a stalled subscription', () => {
  it.each(['unpaid', 'paused'])('flag on: %s is cancelled, dropped and marked', async (status) => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_st', 'sub_st');
    buy(h.fake, 'st', familyId, { status });

    await expect(h.apply(refundEvent(h.fake, 'ch_st'))).resolves.toEqual({
      status: 'applied',
      tier: 'free',
    });

    expect(h.fake.deletes()).toEqual(['sub_st']);
    expect(statuses(h.fake)).toEqual(['canceled']);
    expect(await planTier(familyId)).toBe('free');
    expect((await auditRows(familyId, 'billing_subscription_ended')).length).toBe(1);
  });

  it.each(['unpaid', 'paused'])(
    'flag on: %s keeps the plan on a refund of an older invoice',
    async (status) => {
      const h = harness(FLAG_ON);
      const familyId = await paidFamily('plus', 'cus_st', 'sub_st');
      buy(h.fake, 'st', familyId, { status });
      h.fake.addPaidInvoice({
        subscriptionId: 'sub_st',
        invoiceId: 'in_prior',
        chargeId: 'ch_prior',
        paymentIntentId: 'pi_prior',
        periodStart: BOUGHT - 365 * DAY,
        periodEnd: BOUGHT,
        billingReason: 'subscription_cycle',
        latest: false,
      });

      await expect(h.apply(refundEvent(h.fake, 'ch_prior'))).resolves.toEqual({
        status: 'kept',
        reason: 'older_invoice',
      });

      expect(h.fake.deletes()).toEqual([]);
      expect(await planTier(familyId)).toBe('plus');
      expect(await auditRows(familyId, 'billing_subscription_ended')).toEqual([]);
      expect(await auditRows(familyId, 'family_plan_updated')).toEqual([]);
    },
  );

  it.each(['unpaid', 'paused'])(
    'flag on: %s with an unproven period pages and cancels nothing',
    async (status) => {
      const h = harness(FLAG_ON);
      const familyId = await paidFamily('plus', 'cus_st', 'sub_st');
      buy(h.fake, 'st', familyId, { status });
      h.fake.addPaidInvoice({
        subscriptionId: 'sub_st',
        invoiceId: 'in_unmatched',
        chargeId: 'ch_unmatched',
        paymentIntentId: 'pi_unmatched',
        periodStart: BOUGHT + DAY,
        periodEnd: BOUGHT + 2 * DAY,
        billingReason: 'subscription_cycle',
      });
      const event = refundEvent(h.fake, 'ch_unmatched');

      await expect(h.apply(event)).resolves.toMatchObject({
        status: 'unresolved',
        reason: 'current_period_unproven',
      });

      expect(h.fake.deletes()).toEqual([]);
      expect(await planTier(familyId)).toBe('plus');
      expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'current_period_unproven' }]);
    },
  );

  it.each(['unpaid', 'paused'])(
    'flag off: %s is kept with no cancel and no marker',
    async (status) => {
      const h = harness(FLAG_OFF);
      const familyId = await paidFamily('plus', 'cus_st', 'sub_st');
      buy(h.fake, 'st', familyId, { status });

      await expect(h.apply(refundEvent(h.fake, 'ch_st'))).resolves.toEqual({
        status: 'kept',
        reason: 'subscription_not_ended',
      });

      expect(h.fake.deletes()).toEqual([]);
      expect(await planTier(familyId)).toBe('plus');
      expect(await auditRows(familyId, 'billing_subscription_ended')).toEqual([]);
    },
  );
});

describe('what never drops a family', () => {
  it('a subscription whose metadata names another family: unresolved, no cancel', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_mis', 'sub_mis');
    const otherFamily = await paidFamily('plus', 'cus_x', null);
    buy(h.fake, 'mis', otherFamily, { customer: 'cus_mis' });
    const charge = h.fake.charges.get('ch_mis');
    if (!charge) throw new Error('no charge');
    charge.metadata = { familyId };
    const event = refundEvent(h.fake, 'ch_mis');

    await expect(h.apply(event)).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'subscription_unresolved',
    });

    expect(h.fake.deletes()).toEqual([]);
    expect(await planTier(familyId)).toBe('plus');
    expect(await planTier(otherFamily)).toBe('plus');
  });

  it('an untied full refund, no stored id: unresolved, claimed, and a replay pages once', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_untied', null);
    buy(h.fake, 'untied', familyId);
    h.fake.invoicePayments.length = 0;
    const event = refundEvent(h.fake, 'ch_untied');

    await expect(h.apply(event)).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'subscription_unresolved',
    });
    expect(await planTier(familyId)).toBe('plus');
    expect(await claimed(event.id)).toBe(true);
    expect(await verbs(familyId)).toEqual(['billing_revoke_unresolved']);
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'subscription_unresolved' }]);

    await expect(h.apply(event)).resolves.toEqual({ status: 'duplicate' });
    expect(h.unresolved.length).toBe(1);
  });
});

describe('Stripe failures are retried, never claimed', () => {
  it('a 503 returns retry with no claim and no page, and the next delivery applies', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_503', 'sub_503');
    buy(h.fake, '503', familyId);
    const event = refundEvent(h.fake, 'ch_503');
    h.fake.intercept(
      (call) => call.path === '/v1/invoice_payments',
      () => stripeError(503),
      1,
    );

    await expect(h.apply(event)).resolves.toEqual({
      status: 'retry',
      reason: 'stripe_unavailable',
    });
    expect(await claimed(event.id)).toBe(false);
    expect(await planTier(familyId)).toBe('plus');
    expect(h.refusedPages).toEqual([]);
    expect(h.unresolved).toEqual([]);

    await expect(h.apply(event)).resolves.toEqual({
      status: 'kept',
      reason: 'active_subscription',
    });
    expect(await claimed(event.id)).toBe(true);
  });

  it('a 403 on invoice payments pages once across deliveries and a healthy one applies', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_403', 'sub_403');
    buy(h.fake, '403', familyId);
    const event = refundEvent(h.fake, 'ch_403');
    h.fake.intercept(
      (call) => call.path === '/v1/invoice_payments',
      () => stripeError(403),
      2,
    );

    const first = await h.apply(event);
    expect(first).toMatchObject({ status: 'retry', reason: 'stripe_refused', opsAlert: 'paged' });
    const second = await h.apply(event);
    expect(second).toMatchObject({
      status: 'retry',
      reason: 'stripe_refused',
      opsAlert: 'already_paged',
    });

    expect(await claimed(event.id)).toBe(false);
    expect(await planTier(familyId)).toBe('plus');
    expect(h.refusedPages.length).toBe(1);
    expect(h.refusedPages[0]).toContain('site billing_stripe_refused.');
    expect(h.refusedPages[0]).toContain('call lookup.');
    expect(h.refusedPages[0]).toContain('status 403.');

    await expect(h.apply(event)).resolves.toEqual({
      status: 'kept',
      reason: 'active_subscription',
    });
    expect(await claimed(event.id)).toBe(true);
  });

  it('a 404 on the event charge is a refusal, not a claimed "not tied"', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_404', 'sub_404');
    buy(h.fake, '404', familyId);
    const event = refundEvent(h.fake, 'ch_404');
    h.fake.charges.delete('ch_404');

    await expect(h.apply(event)).resolves.toMatchObject({
      status: 'retry',
      reason: 'stripe_refused',
      opsAlert: 'paged',
    });
    expect(await claimed(event.id)).toBe(false);
    expect(await planTier(familyId)).toBe('plus');
    expect(h.refusedPages[0]).toContain('status 404.');
  });

  it('a missing key on a charge that needs a lookup is named, paged and retried', async () => {
    const h = harness({ STRIPE_BILLING_REVOKE_ENABLED: 'true' });
    const familyId = await paidFamily('plus', 'cus_nokey', 'sub_nokey');
    buy(h.fake, 'nokey', familyId);
    const event = refundEvent(h.fake, 'ch_nokey');

    await expect(h.apply(event)).resolves.toMatchObject({
      status: 'retry',
      reason: 'stripe_not_configured',
      opsAlert: 'paged',
    });
    expect(await claimed(event.id)).toBe(false);
    expect(h.refusedPages[0]).toContain('status no_key.');
  });

  it('flag on: a DELETE that fails returns retry, no claim, plan kept, paged once', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_del', 'sub_del');
    buy(h.fake, 'del', familyId);
    const event = refundEvent(h.fake, 'ch_del');
    h.fake.intercept(
      (call) => call.method === 'DELETE',
      () => stripeError(500),
    );

    const first = await h.apply(event);
    expect(first).toMatchObject({
      status: 'retry',
      reason: 'stripe_cancel_failed',
      opsAlert: 'paged',
    });
    await h.apply(event);

    expect(await claimed(event.id)).toBe(false);
    expect(await planTier(familyId)).toBe('plus');
    expect(h.refusedPages.length).toBe(1);
    expect(h.refusedPages[0]).toContain('call cancel.');
    expect(h.refusedPages[0]).toContain('status unknown.');
  });

  it('an already cancelled subscription is not cancelled again', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_race', 'sub_race');
    buy(h.fake, 'race', familyId);
    const event = refundEvent(h.fake, 'ch_race');
    h.fake.intercept(
      (call) => call.path === '/v1/subscriptions/search',
      () => {
        const subscription = h.fake.subscriptions.get('sub_race');
        if (subscription) subscription.status = 'canceled';
        return Response.json({ object: 'search_result', has_more: false, data: [] });
      },
      1,
    );

    await expect(h.apply(event)).resolves.toEqual({ status: 'applied', tier: 'free' });
    expect(h.fake.deletes()).toEqual([]);
    expect(await planTier(familyId)).toBe('free');
  });

  it('a DELETE that fails but left the subscription cancelled still drops', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_half', 'sub_half');
    buy(h.fake, 'half', familyId);
    const event = refundEvent(h.fake, 'ch_half');
    h.fake.intercept(
      (call) => call.method === 'DELETE',
      () => {
        const subscription = h.fake.subscriptions.get('sub_half');
        if (subscription) subscription.status = 'canceled';
        return stripeError(500);
      },
    );

    await expect(h.apply(event)).resolves.toEqual({ status: 'applied', tier: 'free' });
    expect(h.fake.deletes()).toEqual(['sub_half']);
    expect(await planTier(familyId)).toBe('free');
    expect(h.refusedPages).toEqual([]);
  });
});

describe('what could bring the tier back', () => {
  it('late grants for the ended subscription are blocked, and a new purchase is not', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_late', 'sub_late');
    buy(h.fake, 'late', familyId);
    await h.apply(refundEvent(h.fake, 'ch_late'));
    expect(await planTier(familyId)).toBe('free');

    await expect(h.apply(invoicePaidEvent(familyId, 'sub_late'))).resolves.toEqual({
      status: 'blocked',
    });
    await expect(h.apply(subscriptionUpdatedEvent(h.fake, 'sub_late'))).resolves.toEqual({
      status: 'blocked',
    });
    expect(await planTier(familyId)).toBe('free');
    const blocked = await auditRows(familyId, 'billing_grant_blocked');
    expect(blocked.length).toBe(2);
    expect(blocked[0]?.after).toMatchObject({
      subscriptionId: 'sub_late',
      prior: 'billing_subscription_ended',
    });

    await expect(h.apply(invoicePaidEvent(familyId, 'sub_bought_again'))).resolves.toEqual({
      status: 'applied',
      tier: 'plus',
    });
    expect(await planTier(familyId)).toBe('plus');
  });
});

describe('the marker read', () => {
  it('finds the ended marker on a family with more than 50 block rows', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_many', 'sub_many');
    buy(h.fake, 'many', familyId);
    await db.database.insert(schema.auditLog).values(
      Array.from({ length: 60 }, (_unused, index) => ({
        familyId,
        actor: 'system',
        actionTaken: 'billing_refund_ready',
        targetTable: 'families',
        targetId: familyId,
        after: { subscriptionId: `sub_other_${index}` },
      })),
    );
    await expect(h.apply(refundEvent(h.fake, 'ch_many'))).resolves.toEqual({
      status: 'applied',
      tier: 'free',
    });

    await expect(h.apply(subscriptionUpdatedEvent(h.fake, 'sub_many'))).resolves.toEqual({
      status: 'blocked',
    });

    expect(await planTier(familyId)).toBe('free');
  });

  it('positive control: another subscription on that family is not blocked', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('free', 'cus_clean', null);
    buy(h.fake, 'clean', familyId);
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'billing_refund_ready',
      targetTable: 'families',
      targetId: familyId,
      after: { subscriptionId: 'sub_someone_else' },
    });

    await expect(h.apply(subscriptionUpdatedEvent(h.fake, 'sub_clean'))).resolves.toEqual({
      status: 'applied',
      tier: 'plus',
    });
  });
});

describe('customer.subscription.deleted, flag on', () => {
  it('the echo of our own cancel adds no problem row', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_echo', 'sub_echo');
    buy(h.fake, 'echo', familyId);
    await h.apply(refundEvent(h.fake, 'ch_echo'));
    const event = deletedEvent(h.fake, 'sub_echo');
    const before = await verbs(familyId);

    await expect(h.apply(event)).resolves.toEqual({
      status: 'kept',
      reason: 'subscription_already_ended',
    });

    expect(await verbs(familyId)).toEqual(before);
    expect(await claimed(event.id)).toBe(true);
    expect(await planTier(familyId)).toBe('free');
  });

  it('a duplicate cancelled by hand keeps the plan held on another customer', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_b', 'sub_b');
    buy(h.fake, 'a', familyId, { customer: 'cus_a' });
    buy(h.fake, 'b', familyId, { customer: 'cus_b' });
    const event = deletedEvent(h.fake, 'sub_b');

    await expect(h.apply(event)).resolves.toEqual({
      status: 'kept',
      reason: 'active_subscription',
    });

    expect(await planTier(familyId)).toBe('plus');
    expect(await claimed(event.id)).toBe(true);
    const [marker] = await auditRows(familyId, 'billing_subscription_ended');
    expect(marker?.after).toMatchObject({
      subscriptionId: 'sub_b',
      reason: 'other_subscription_live',
      tierChanged: false,
    });
  });

  it('a late .deleted after buying again keeps the new plan', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_new', 'sub_new');
    buy(h.fake, 'old', familyId, { customer: 'cus_new' });
    buy(h.fake, 'new', familyId, { customer: 'cus_new' });

    await expect(h.apply(deletedEvent(h.fake, 'sub_old'))).resolves.toEqual({
      status: 'kept',
      reason: 'active_subscription',
    });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('positive control: a .deleted with nothing else live still drops, and is marked', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_only', 'sub_only');
    buy(h.fake, 'only', familyId);
    const event = deletedEvent(h.fake, 'sub_only');

    await expect(h.apply(event)).resolves.toEqual({ status: 'applied', tier: 'free' });

    expect(await planTier(familyId)).toBe('free');
    const [marker] = await auditRows(familyId, 'billing_subscription_ended');
    expect(marker?.after).toEqual({
      source: 'stripe',
      stripeEventId: event.id,
      subscriptionId: 'sub_only',
      reason: 'subscription_deleted',
      tierChanged: true,
    });
  });

  it('a .deleted with a refunded sibling cancels it and drops', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_b', 'sub_b');
    buy(h.fake, 'a', familyId, { customer: 'cus_a' });
    buy(h.fake, 'b', familyId, { customer: 'cus_b' });
    h.fake.refund('ch_a');
    const event = deletedEvent(h.fake, 'sub_b');

    await expect(h.apply(event)).resolves.toEqual({ status: 'applied', tier: 'free' });

    expect(h.fake.deletes()).toEqual(['sub_a']);
    expect(await planTier(familyId)).toBe('free');
    const markers = await auditRows(familyId, 'billing_subscription_ended');
    expect(
      markers.map((row) => (row.after as { subscriptionId: string }).subscriptionId).sort(),
    ).toEqual(['sub_a', 'sub_b']);
  });

  it('a young .deleted with nothing found waits', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_y', 'sub_y');
    buy(h.fake, 'y', familyId, { created: NOW_S - 300 });
    const event = deletedEvent(h.fake, 'sub_y');

    await expect(h.apply(event)).resolves.toEqual({ status: 'retry', reason: 'search_settling' });
    expect(await claimed(event.id)).toBe(false);
    expect(await planTier(familyId)).toBe('plus');
  });

  it('a Stripe failure on the guard scan retries and leaves the plan', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_g', 'sub_g');
    buy(h.fake, 'g', familyId);
    h.fake.intercept(
      (call) => call.path === '/v1/subscriptions/search',
      () => stripeError(500),
    );
    const event = deletedEvent(h.fake, 'sub_g');

    await expect(h.apply(event)).resolves.toEqual({
      status: 'retry',
      reason: 'stripe_unavailable',
    });
    expect(await claimed(event.id)).toBe(false);
    expect(await planTier(familyId)).toBe('plus');
  });

  it('a replayed .deleted makes no Stripe call', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_replay', 'sub_replay');
    buy(h.fake, 'replay', familyId);
    const event = deletedEvent(h.fake, 'sub_replay');
    await h.apply(event);
    const before = h.fake.calls.length;

    await expect(h.apply(event)).resolves.toEqual({ status: 'duplicate' });
    expect(h.fake.calls.length).toBe(before);
  });
});

describe('races around the write', () => {
  it('.deleted landing between the cancel and the commit settles as one drop', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_mid', 'sub_mid');
    buy(h.fake, 'mid', familyId);
    const event = refundEvent(h.fake, 'ch_mid');
    let delivered: unknown = null;
    h.fake.duringDelete(async (id) => {
      delivered = await h.apply(deletedEvent(h.fake, id));
    });

    await expect(h.apply(event)).resolves.toEqual({ status: 'retry', reason: 'family_changed' });
    expect(delivered).toEqual({ status: 'applied', tier: 'free' });
    expect(await claimed(event.id)).toBe(false);

    await expect(h.apply(event)).resolves.toEqual({ status: 'kept', reason: 'already_free' });
    expect(await claimed(event.id)).toBe(true);
    const drops = (await auditRows(familyId, 'family_plan_updated')).filter(
      (row) => (row.after as { planTier?: string }).planTier === 'free',
    );
    expect(drops.length).toBe(1);
    const markers = await auditRows(familyId, 'billing_subscription_ended');
    expect(markers.length).toBe(1);
    expect(markers[0]?.after).toMatchObject({
      subscriptionId: 'sub_mid',
      reason: 'subscription_deleted',
      tierChanged: true,
    });
  });

  it('a sibling whose .deleted lands before the refund commits can never re-grant', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_b', 'sub_b');
    buy(h.fake, 'a', familyId, { customer: 'cus_a' });
    buy(h.fake, 'b', familyId, { customer: 'cus_b' });
    await h.apply(refundEvent(h.fake, 'ch_b'));
    const last = refundEvent(h.fake, 'ch_a');
    let delivered: unknown = null;
    h.fake.duringDelete(async (id) => {
      if (id === 'sub_b') delivered = await h.apply(deletedEvent(h.fake, 'sub_b'));
    });

    await expect(h.apply(last)).resolves.toEqual({ status: 'retry', reason: 'family_changed' });
    expect(delivered).toEqual({ status: 'applied', tier: 'free' });
    await expect(h.apply(last)).resolves.toEqual({ status: 'kept', reason: 'already_free' });
    expect(statuses(h.fake)).toEqual(['canceled', 'canceled']);

    await expect(h.apply(invoicePaidEvent(familyId, 'sub_b'))).resolves.toEqual({
      status: 'blocked',
    });
    await expect(h.apply(invoicePaidEvent(familyId, 'sub_a'))).resolves.toEqual({
      status: 'blocked',
    });
    expect(await planTier(familyId)).toBe('free');
  });

  it('a purchase committing between the read and the write stands', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_buy', 'sub_buy');
    buy(h.fake, 'buy', familyId);
    const event = refundEvent(h.fake, 'ch_buy');
    h.fake.duringDelete(async () => {
      await db.database
        .update(schema.families)
        .set({ planTier: 'family', stripeSubscriptionId: 'sub_newer' })
        .where(eq(schema.families.id, familyId));
    });

    await expect(h.apply(event)).resolves.toEqual({ status: 'retry', reason: 'family_changed' });

    expect(await planTier(familyId)).toBe('family');
    expect(await claimed(event.id)).toBe(false);
  });
});

describe('a refunded subscription that stays live cannot grant a tier', () => {
  async function plusWithRefundedMax(h: ReturnType<typeof harness>) {
    const familyId = await paidFamily('plus', 'cus_plus', 'sub_plus');
    buy(h.fake, 'plus', familyId, { priceId: 'price_plus' });
    buy(h.fake, 'max', familyId, { priceId: 'price_max' });
    const event = refundEvent(h.fake, 'ch_max');
    await expect(h.apply(event)).resolves.toEqual({
      status: 'kept',
      reason: 'duplicate_subscription',
    });
    return { familyId, event };
  }

  it('flag on: its next update does not raise a family on Plus to Max', async () => {
    const h = harness(FLAG_ON);
    const { familyId, event } = await plusWithRefundedMax(h);

    await expect(
      h.apply(subscriptionUpdatedEvent(h.fake, 'sub_max', { cancel_at_period_end: true })),
    ).resolves.toEqual({ status: 'blocked' });

    expect(await planTier(familyId)).toBe('plus');
    expect(h.unresolved).toEqual([]);
    expect(h.fake.deletes()).toEqual([]);
    const holds = await auditRows(familyId, 'billing_grant_held');
    expect(holds.map((row) => row.after)).toEqual([
      {
        source: 'stripe',
        stripeEventId: event.id,
        subscriptionId: 'sub_max',
        liftsOnRenewalAfter: BOUGHT,
      },
    ]);
    const [blocked] = await auditRows(familyId, 'billing_grant_blocked');
    expect(blocked?.after).toMatchObject({
      subscriptionId: 'sub_max',
      prior: 'billing_grant_held',
    });
  });

  it.each([
    ['its own invoice.paid, delivered late', (fake: FakeStripe) => paidEventFor(fake, 'in_max')],
    [
      'a late subscription.created',
      (fake: FakeStripe) => ({
        ...subscriptionUpdatedEvent(fake, 'sub_max'),
        type: 'customer.subscription.created',
      }),
    ],
    [
      'a late checkout.session.completed',
      (fake: FakeStripe, familyId: string) => ({
        id: nextEventId('checkout'),
        type: 'checkout.session.completed',
        created: NOW_S,
        data: {
          object: {
            id: 'cs_max',
            subscription: 'sub_max',
            customer: fake.subscriptions.get('sub_max')?.customer,
            client_reference_id: familyId,
            metadata: { familyId, tier: 'family' },
          },
        },
      }),
    ],
  ] as const)('flag on: %s cannot grant it', async (_name, late) => {
    const h = harness(FLAG_ON);
    const { familyId } = await plusWithRefundedMax(h);

    await expect(h.apply(late(h.fake, familyId))).resolves.toEqual({ status: 'blocked' });

    expect(await planTier(familyId)).toBe('plus');
  });

  it.each([
    ['a proration invoice', { billing_reason: 'subscription_update' }],
    ['a renewal that took no money', { amount_paid: 0 }],
    ['an invoice older than the refunded one', { created: BOUGHT - DAY }],
    ['an invoice with no created time', { created: undefined }],
  ])('flag on: %s does not lift the hold', async (_name, over) => {
    const h = harness(FLAG_ON);
    const { familyId } = await plusWithRefundedMax(h);
    const invoiceId = addRenewal(h.fake, 'sub_max');

    await expect(h.apply(paidEventFor(h.fake, invoiceId, over))).resolves.toEqual({
      status: 'blocked',
    });

    expect(await planTier(familyId)).toBe('plus');
    expect(await auditRows(familyId, 'billing_grant_released')).toEqual([]);
  });

  it('positive control: a new paid renewal raises the family and lifts the hold', async () => {
    const h = harness(FLAG_ON);
    const { familyId } = await plusWithRefundedMax(h);
    const invoiceId = addRenewal(h.fake, 'sub_max');
    const renewal = paidEventFor(h.fake, invoiceId);

    await expect(h.apply(renewal)).resolves.toEqual({ status: 'applied', tier: 'family' });

    expect(await planTier(familyId)).toBe('family');
    const released = await auditRows(familyId, 'billing_grant_released');
    expect(released.map((row) => row.after)).toEqual([
      { source: 'stripe', stripeEventId: renewal.id, subscriptionId: 'sub_max' },
    ]);
    await expect(h.apply(subscriptionUpdatedEvent(h.fake, 'sub_max'))).resolves.toEqual({
      status: 'applied',
      tier: 'family',
    });
  });

  it('a refund of that new renewal holds the subscription again', async () => {
    const h = harness(FLAG_ON);
    const { familyId } = await plusWithRefundedMax(h);
    const invoiceId = addRenewal(h.fake, 'sub_max');
    await h.apply(paidEventFor(h.fake, invoiceId));
    await db.database
      .update(schema.families)
      .set({ planTier: 'plus', stripeSubscriptionId: 'sub_plus' })
      .where(eq(schema.families.id, familyId));

    await expect(h.apply(refundEvent(h.fake, 'ch_renewal_sub_max'))).resolves.toEqual({
      status: 'kept',
      reason: 'duplicate_subscription',
    });

    await expect(h.apply(subscriptionUpdatedEvent(h.fake, 'sub_max'))).resolves.toEqual({
      status: 'blocked',
    });
    // The refunded renewal's own invoice, redelivered under a new event id, is not newer.
    await expect(h.apply(paidEventFor(h.fake, invoiceId))).resolves.toEqual({ status: 'blocked' });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('flag on: the hold is also written when the refund pages', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('family', 'cus_max', 'sub_max');
    buy(h.fake, 'max', familyId, { priceId: 'price_max' });
    buy(h.fake, 'plus', familyId, { priceId: 'price_plus' });

    await expect(h.apply(refundEvent(h.fake, 'ch_max'))).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'surviving_plan_differs',
    });

    await expect(h.apply(subscriptionUpdatedEvent(h.fake, 'sub_max'))).resolves.toEqual({
      status: 'blocked',
    });
    expect(await planTier(familyId)).toBe('family');
  });

  it('flag on: a duplicate already cancelled in Stripe cannot grant through a late update', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_plus', 'sub_plus');
    buy(h.fake, 'plus', familyId, { priceId: 'price_plus' });
    buy(h.fake, 'max', familyId, { priceId: 'price_max', status: 'canceled' });

    await expect(h.apply(refundEvent(h.fake, 'ch_max'))).resolves.toEqual({
      status: 'kept',
      reason: 'active_subscription',
    });

    await expect(h.apply(subscriptionUpdatedEvent(h.fake, 'sub_max'))).resolves.toEqual({
      status: 'blocked',
    });
    expect(await planTier(familyId)).toBe('plus');

    // A cancelled subscription never renews, so even a newer paid invoice cannot lift this.
    const invoiceId = addRenewal(h.fake, 'sub_max');
    await expect(h.apply(paidEventFor(h.fake, invoiceId))).resolves.toEqual({ status: 'blocked' });
    expect(await planTier(familyId)).toBe('plus');
    expect(await auditRows(familyId, 'billing_grant_released')).toEqual([]);
  });

  it('flag on: a refund of its latest invoice with an unproven period holds it until a renewal', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_plus', 'sub_plus');
    buy(h.fake, 'plus', familyId, { priceId: 'price_plus' });
    buy(h.fake, 'max', familyId, { priceId: 'price_max' });
    h.fake.addPaidInvoice({
      subscriptionId: 'sub_max',
      invoiceId: 'in_unmatched',
      chargeId: 'ch_unmatched',
      paymentIntentId: 'pi_unmatched',
      periodStart: BOUGHT + DAY,
      periodEnd: BOUGHT + 2 * DAY,
      billingReason: 'subscription_cycle',
    });
    await expect(h.apply(refundEvent(h.fake, 'ch_unmatched'))).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'current_period_unproven',
    });

    await expect(h.apply(subscriptionUpdatedEvent(h.fake, 'sub_max'))).resolves.toEqual({
      status: 'blocked',
    });
    expect(await planTier(familyId)).toBe('plus');

    const invoiceId = addRenewal(h.fake, 'sub_max');
    await expect(h.apply(paidEventFor(h.fake, invoiceId))).resolves.toEqual({
      status: 'applied',
      tier: 'family',
    });
  });

  it('positive control: a refund of an older invoice writes no hold, so updates still apply', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_old', 'sub_old');
    buy(h.fake, 'old', familyId);
    h.fake.addPaidInvoice({
      subscriptionId: 'sub_old',
      invoiceId: 'in_prior',
      chargeId: 'ch_prior',
      paymentIntentId: 'pi_prior',
      periodStart: BOUGHT - 365 * DAY,
      periodEnd: BOUGHT,
      billingReason: 'subscription_cycle',
      latest: false,
    });
    await expect(h.apply(refundEvent(h.fake, 'ch_prior'))).resolves.toEqual({
      status: 'kept',
      reason: 'older_invoice',
    });

    await expect(h.apply(subscriptionUpdatedEvent(h.fake, 'sub_old'))).resolves.toEqual({
      status: 'applied',
      tier: 'plus',
    });
    expect(await auditRows(familyId, 'billing_grant_held')).toEqual([]);
  });

  it('flag off: a refunded duplicate writes no hold and its update applies as today', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_plus', 'sub_plus');
    buy(h.fake, 'plus', familyId, { priceId: 'price_plus' });
    buy(h.fake, 'max', familyId, { priceId: 'price_max' });

    await expect(h.apply(refundEvent(h.fake, 'ch_max'))).resolves.toEqual({
      status: 'kept',
      reason: 'active_subscription',
    });
    await expect(h.apply(subscriptionUpdatedEvent(h.fake, 'sub_max'))).resolves.toEqual({
      status: 'applied',
      tier: 'family',
    });

    expect(await auditRows(familyId, 'billing_grant_held')).toEqual([]);
  });

  it('a hold keeps blocking after the flag is turned off', async () => {
    const on = harness(FLAG_ON);
    const { familyId } = await plusWithRefundedMax(on);

    const off = harness(FLAG_OFF);
    await expect(
      applyStripeBillingEvent(
        subscriptionUpdatedEvent(on.fake, 'sub_max'),
        db.database,
        TIERS,
        {},
        off.deps(),
      ),
    ).resolves.toEqual({ status: 'blocked' });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('the subscription ending still goes through a hold', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_only', 'sub_only');
    buy(h.fake, 'only', familyId);
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'billing_grant_held',
      targetTable: 'families',
      targetId: familyId,
      after: { source: 'stripe', subscriptionId: 'sub_only', liftsOnRenewalAfter: BOUGHT },
    });

    await expect(h.apply(deletedEvent(h.fake, 'sub_only'))).resolves.toEqual({
      status: 'applied',
      tier: 'free',
    });
    expect(await planTier(familyId)).toBe('free');
  });
});

describe('customer.subscription.deleted, flag on: the tier follows what is still paid', () => {
  async function twoLive(
    plan: PlanTier,
    h: ReturnType<typeof harness>,
    survivor: { priceId: string; status?: string },
  ) {
    const familyId = await paidFamily(plan, 'cus_ending', 'sub_ending');
    buy(h.fake, 'ending', familyId, { priceId: plan === 'family' ? 'price_max' : 'price_plus' });
    buy(h.fake, 'left', familyId, survivor);
    return familyId;
  }

  it('Max ended with Plus left: the family moves to Plus', async () => {
    const h = harness(FLAG_ON);
    const familyId = await twoLive('family', h, { priceId: 'price_plus' });
    const event = deletedEvent(h.fake, 'sub_ending');

    await expect(h.apply(event)).resolves.toEqual({ status: 'applied', tier: 'plus' });

    expect(await planTier(familyId)).toBe('plus');
    expect(h.unresolved).toEqual([]);
    expect(h.fake.deletes()).toEqual([]);
    expect(await claimed(event.id)).toBe(true);
    const [write] = await auditRows(familyId, 'family_plan_updated');
    expect(write?.after).toEqual({
      planTier: 'plus',
      source: 'stripe',
      stripeEventId: event.id,
      reason: 'surviving_subscription',
    });
    const [marker] = await auditRows(familyId, 'billing_subscription_ended');
    expect(marker?.after).toMatchObject({
      subscriptionId: 'sub_ending',
      reason: 'other_subscription_live',
      tierChanged: true,
    });

    await expect(h.apply(subscriptionUpdatedEvent(h.fake, 'sub_ending'))).resolves.toEqual({
      status: 'blocked',
    });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('Plus ended with Max left: the family moves to Max', async () => {
    const h = harness(FLAG_ON);
    const familyId = await twoLive('plus', h, { priceId: 'price_max' });

    await expect(h.apply(deletedEvent(h.fake, 'sub_ending'))).resolves.toEqual({
      status: 'applied',
      tier: 'family',
    });

    expect(await planTier(familyId)).toBe('family');
    expect(h.unresolved).toEqual([]);
  });

  it('Plus ended with a past-due Max left: no raise on an unpaid subscription, and it pages', async () => {
    const h = harness(FLAG_ON);
    const familyId = await twoLive('plus', h, { priceId: 'price_max', status: 'past_due' });
    const event = deletedEvent(h.fake, 'sub_ending');

    await expect(h.apply(event)).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'surviving_plan_differs',
    });

    expect(await planTier(familyId)).toBe('plus');
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'surviving_plan_differs' }]);
  });

  it('Max ended with a past-due Plus left: moving down still applies', async () => {
    const h = harness(FLAG_ON);
    const familyId = await twoLive('family', h, { priceId: 'price_plus', status: 'past_due' });

    await expect(h.apply(deletedEvent(h.fake, 'sub_ending'))).resolves.toEqual({
      status: 'applied',
      tier: 'plus',
    });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('the same tier left: kept with no tier write and no page', async () => {
    const h = harness(FLAG_ON);
    const familyId = await twoLive('plus', h, { priceId: 'price_plus' });

    await expect(h.apply(deletedEvent(h.fake, 'sub_ending'))).resolves.toEqual({
      status: 'kept',
      reason: 'active_subscription',
    });

    expect(await planTier(familyId)).toBe('plus');
    expect(await auditRows(familyId, 'family_plan_updated')).toEqual([]);
    expect(h.unresolved).toEqual([]);
  });

  it('an unmapped price left: keeps the plan, marks the ended one, and pages', async () => {
    const h = harness(FLAG_ON);
    const familyId = await twoLive('family', h, { priceId: 'price_unmapped' });
    const event = deletedEvent(h.fake, 'sub_ending');

    await expect(h.apply(event)).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'surviving_plan_differs',
    });

    expect(await planTier(familyId)).toBe('family');
    expect(await auditRows(familyId, 'family_plan_updated')).toEqual([]);
    expect((await verbs(familyId)).sort()).toEqual([
      'billing_revoke_unresolved',
      'billing_subscription_ended',
    ]);
    const [marker] = await auditRows(familyId, 'billing_subscription_ended');
    expect(marker?.after).toMatchObject({ subscriptionId: 'sub_ending', tierChanged: false });
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'surviving_plan_differs' }]);
    expect(await claimed(event.id)).toBe(true);
  });

  it('mixed tiers left: keeps the plan and pages', async () => {
    const h = harness(FLAG_ON);
    const familyId = await twoLive('family', h, { priceId: 'price_plus' });
    buy(h.fake, 'third', familyId, { priceId: 'price_max' });

    await expect(h.apply(deletedEvent(h.fake, 'sub_ending'))).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'surviving_plan_differs',
    });
    expect(await planTier(familyId)).toBe('family');
  });

  it('a truncated scan: keeps the plan and pages', async () => {
    const h = harness(FLAG_ON);
    const familyId = await twoLive('family', h, { priceId: 'price_plus' });
    h.fake.intercept(
      (call) => call.path === '/v1/subscriptions/search',
      () => Response.json({ object: 'search_result', has_more: true, data: [] }),
    );

    await expect(h.apply(deletedEvent(h.fake, 'sub_ending'))).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'surviving_plan_differs',
    });
    expect(await planTier(familyId)).toBe('family');
  });

  it('a survivor whose own grant was refused cannot set the tier', async () => {
    const h = harness(FLAG_ON);
    const familyId = await twoLive('family', h, { priceId: 'price_plus' });
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'billing_refund_ready',
      targetTable: 'families',
      targetId: familyId,
      after: { subscriptionId: 'sub_left' },
    });

    await expect(h.apply(deletedEvent(h.fake, 'sub_ending'))).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'surviving_plan_differs',
    });
    expect(await planTier(familyId)).toBe('family');
  });

  it('a family on free is not granted anything when a duplicate ends', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('free', 'cus_ending', 'sub_ending');
    buy(h.fake, 'ending', familyId);
    buy(h.fake, 'left', familyId, { priceId: 'price_max' });

    await expect(h.apply(deletedEvent(h.fake, 'sub_ending'))).resolves.toEqual({
      status: 'kept',
      reason: 'active_subscription',
    });
    expect(await planTier(familyId)).toBe('free');
    expect(h.unresolved).toEqual([]);
  });

  it('acting on the page corrects the tier: Max refunded, then cancelled by hand', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('family', 'cus_max', 'sub_max');
    buy(h.fake, 'max', familyId, { priceId: 'price_max' });
    buy(h.fake, 'plus', familyId, { priceId: 'price_plus' });
    await expect(h.apply(refundEvent(h.fake, 'ch_max'))).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'surviving_plan_differs',
    });

    await expect(h.apply(deletedEvent(h.fake, 'sub_max'))).resolves.toEqual({
      status: 'applied',
      tier: 'plus',
    });

    expect(await planTier(familyId)).toBe('plus');
    expect(h.unresolved.length).toBe(1);
  });

  it('a family that changed under the deletion is retried, not overwritten', async () => {
    const h = harness(FLAG_ON);
    const familyId = await twoLive('family', h, { priceId: 'price_plus' });
    const event = deletedEvent(h.fake, 'sub_ending');
    h.fake.intercept(
      (call) => call.path === '/v1/subscriptions/search',
      async (call) => {
        await db.database
          .update(schema.families)
          .set({ stripeSubscriptionId: 'sub_newer' })
          .where(eq(schema.families.id, familyId));
        h.fake.clearIntercepts();
        return h.fake.fetch(`https://api.stripe.com${call.path}?${call.query}`);
      },
    );

    await expect(h.apply(event)).resolves.toEqual({ status: 'retry', reason: 'family_changed' });

    expect(await planTier(familyId)).toBe('family');
    expect(await claimed(event.id)).toBe(false);
  });
});

describe('customer.subscription.deleted, flag off', () => {
  it('drops as it does today and makes no Stripe call', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_off', 'sub_off');
    buy(h.fake, 'off', familyId);
    const event = deletedEvent(h.fake, 'sub_off');

    await expect(h.apply(event)).resolves.toEqual({ status: 'applied', tier: 'free' });

    expect(h.fake.calls).toEqual([]);
    expect(await planTier(familyId)).toBe('free');
  });
});

describe('disputes through the real chain', () => {
  const DROP = { status: 'applied', tier: 'free' };

  it('D1: a live subscription keeps the plan, pages, and never says refunded', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_d1', 'sub_d1');
    buy(h.fake, 'd1', familyId);
    const event = disputeEvent('ch_d1');

    await expect(h.apply(event)).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'dispute_plan_kept',
    });

    expect(await planTier(familyId)).toBe('plus');
    expect(await verbs(familyId)).toEqual(['billing_revoke_unresolved']);
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'dispute_plan_kept' }]);
    expect(await claimed(event.id)).toBe(true);
    expect(h.fake.deletes()).toEqual([]);
  });

  it('D2: an ended subscription keeps a family still paying on another', async () => {
    const h = harness(FLAG_ON);
    const familyId = await paidFamily('plus', 'cus_b', 'sub_b');
    buy(h.fake, 'a', familyId, { customer: 'cus_a', status: 'canceled' });
    buy(h.fake, 'b', familyId, { customer: 'cus_b' });

    await expect(h.apply(disputeEvent('ch_a'))).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'dispute_plan_kept',
    });
    expect(await planTier(familyId)).toBe('plus');
    expect(h.fake.deletes()).toEqual([]);
  });

  it.each([
    ['flag on', FLAG_ON],
    ['flag off', FLAG_OFF],
  ])('D3 (%s): ended with nothing else paid still drops, and cancels nothing', async (_n, env) => {
    const h = harness(env);
    const familyId = await paidFamily('plus', 'cus_d3', 'sub_d3');
    buy(h.fake, 'd3', familyId, { status: 'canceled' });

    await expect(h.apply(disputeEvent('ch_d3'))).resolves.toEqual(DROP);
    expect(await planTier(familyId)).toBe('free');
    expect(h.fake.deletes()).toEqual([]);
    expect(await auditRows(familyId, 'billing_refunded')).toEqual([]);
    expect(await auditRows(familyId, 'billing_subscription_ended')).toEqual([]);
  });

  it('D4: ended, stored names another: unresolved', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_d4', 'sub_gone');
    buy(h.fake, 'd4', familyId, { status: 'canceled' });

    await expect(h.apply(disputeEvent('ch_d4'))).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'subscription_unresolved',
    });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('D5: nothing resolved, a stored id: unresolved', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_d5', 'sub_d5');
    buy(h.fake, 'd5', familyId);
    h.fake.invoicePayments.length = 0;

    await expect(h.apply(disputeEvent('ch_d5'))).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'subscription_unresolved',
    });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('D6: nothing resolved, nothing stored, nothing paid: drops', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_d6', null);
    buy(h.fake, 'd6', familyId, { status: 'canceled' });
    h.fake.invoicePayments.length = 0;

    await expect(h.apply(disputeEvent('ch_d6'))).resolves.toEqual(DROP);
    expect(await planTier(familyId)).toBe('free');
  });

  it('D7: nothing resolved, nothing stored, a paid subscription found: kept', async () => {
    const h = harness(FLAG_OFF);
    const familyId = await paidFamily('plus', 'cus_d7', null);
    buy(h.fake, 'd7', familyId);
    h.fake.invoicePayments.length = 0;

    await expect(h.apply(disputeEvent('ch_d7'))).resolves.toMatchObject({
      status: 'unresolved',
      reason: 'dispute_plan_kept',
    });
    expect(await planTier(familyId)).toBe('plus');
  });
});
