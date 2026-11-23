import { randomUUID } from 'node:crypto';
import { schema } from '@hale/db';
import type { PlanTier } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reconcileBillingTiers } from '~/lib/billing/billing-live';
import { alertUnsettledBillingPlan } from '~/lib/monitoring/billing-tier-alert';
import { type FakeStripe, createFakeStripe, stripeError } from '~/lib/testing/fake-stripe';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { type ApplyStripeBillingDeps, applyStripeBillingEvent } from './stripe-billing-apply.js';
import { type PriceTierMap, type SubscriptionFacts, decidePlanTier } from './stripe-billing.js';

/**
 * The plan follows what Stripe says is still paid. Real Postgres, the real reader, and an
 * in-memory Stripe that throws on anything it does not model. The global fetch throws too,
 * so a dependency left out fails the test instead of reaching the network.
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
  await db.database
    .update(schema.families)
    .set({ stripeCustomerId: null, stripeSubscriptionId: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function harness(env: Env = FLAG_ON) {
  const fake = createFakeStripe();
  const held: Array<{ eventId: string; reason: string; planChanged?: boolean }> = [];
  const unresolved: Array<{ eventId: string; reason: string }> = [];
  const pages: string[] = [];
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
    onPlanUnsettled: async (info) => {
      held.push(info);
      return 'sent';
    },
    pageDeps: {
      post: async (text) => {
        pages.push(text);
        return 'sent';
      },
      now: pageNow,
    },
    ...over,
  });
  const apply = (event: unknown, over?: Partial<ApplyStripeBillingDeps>) =>
    applyStripeBillingEvent(event, db.database, TIERS, {}, deps(over));
  return { fake, held, unresolved, pages, deps, apply };
}

async function family(
  tier: PlanTier,
  customer: string | null = null,
  subscription: string | null = null,
): Promise<string> {
  const { familyId } = await seedFamily(db.database, 'Settle family');
  await db.database
    .update(schema.families)
    .set({ planTier: tier, stripeCustomerId: customer, stripeSubscriptionId: subscription })
    .where(eq(schema.families.id, familyId));
  return familyId;
}

function buy(
  fake: FakeStripe,
  suffix: string,
  familyId: string | null,
  over: { customer?: string; status?: string; priceId?: string; created?: number } = {},
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

/** Stripe rolling into a new period: a new open invoice becomes the latest. */
function advancePeriod(fake: FakeStripe, subscriptionId: string): void {
  const subscription = fake.subscriptions.get(subscriptionId);
  const item = subscription?.items.data[0];
  if (!subscription || !item) throw new Error(`no ${subscriptionId}`);
  item.current_period_start = item.current_period_end;
  item.current_period_end += 365 * DAY;
  const renewal = `in_renewal_${subscriptionId}`;
  fake.addOpenInvoice({
    id: renewal,
    customer: subscription.customer,
    subscriptionId,
    created: item.current_period_start,
  });
  subscription.latest_invoice = renewal;
}

function setPrice(fake: FakeStripe, subscriptionId: string, priceId: string): void {
  const item = fake.subscriptions.get(subscriptionId)?.items.data[0];
  if (!item) throw new Error(`no ${subscriptionId}`);
  item.price = { id: priceId };
}

/** Takes a refund back out of Stripe, so a test can build the event before it happens. */
function unrefund(fake: FakeStripe, chargeId: string): void {
  const charge = fake.charges.get(chargeId);
  if (!charge) throw new Error(`no ${chargeId}`);
  charge.refunded = false;
  fake.refunds.length = 0;
}

function refundEvent(
  fake: FakeStripe,
  chargeId: string,
  refund?: Parameters<FakeStripe['refund']>[1],
  created = NOW_S - 60,
) {
  fake.refund(chargeId, refund);
  return {
    id: nextEventId('refund'),
    type: 'charge.refunded',
    created,
    data: { object: { ...fake.charges.get(chargeId) } },
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

/** The payload as Stripe queued it, so `status` may be older than the live object. */
function updatedEvent(
  fake: FakeStripe,
  subscriptionId: string,
  over: Record<string, unknown> = {},
  type = 'customer.subscription.updated',
) {
  const subscription = fake.subscriptions.get(subscriptionId);
  if (!subscription) throw new Error(`no ${subscriptionId}`);
  return {
    id: nextEventId('updated'),
    type,
    created: NOW_S,
    data: { object: { ...subscription, ...over } },
  };
}

function invoicePaid(fake: FakeStripe, invoiceId: string) {
  const invoice = fake.invoices.get(invoiceId);
  if (!invoice) throw new Error(`no ${invoiceId}`);
  return {
    id: nextEventId('invoice_paid'),
    type: 'invoice.paid',
    created: NOW_S,
    data: { object: { ...invoice } },
  };
}

function checkout(
  familyId: string,
  suffix: string,
  tier: string | null = 'plus',
  over: Record<string, unknown> = {},
  created = NOW_S,
) {
  return {
    id: nextEventId('checkout'),
    type: 'checkout.session.completed',
    created,
    data: {
      object: {
        id: `cs_${suffix}`,
        customer: `cus_${suffix}`,
        subscription: `sub_${suffix}`,
        client_reference_id: familyId,
        metadata: tier ? { familyId, tier } : { familyId },
        ...over,
      },
    },
  };
}

async function planTier(familyId: string): Promise<string | undefined> {
  const [row] = await db.database
    .select({ planTier: schema.families.planTier })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  return row?.planTier;
}

async function rows(familyId: string, verb: string) {
  return db.database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, verb)));
}

async function afters(familyId: string, verb: string): Promise<Array<Record<string, unknown>>> {
  return (await rows(familyId, verb)).map((row) => row.after as Record<string, unknown>);
}

async function isClaimed(eventId: string): Promise<boolean> {
  const found = await db.database
    .select({ id: schema.stripeBillingEvents.id })
    .from(schema.stripeBillingEvents)
    .where(eq(schema.stripeBillingEvents.eventId, eventId));
  return found.length === 1;
}

async function planUnsettled(env: Env = FLAG_ON): Promise<number | undefined> {
  const result = await reconcileBillingTiers(
    db.database,
    env,
    (async () => new Response('ok')) as unknown as typeof fetch,
  );
  if (result.status !== 'checked') throw new Error('reconcile did not run');
  return result.mismatches.planUnsettled;
}

describe('decidePlanTier', () => {
  const sub = (over: Partial<SubscriptionFacts> = {}): SubscriptionFacts => ({
    id: 'sub_a',
    status: 'active',
    priceId: 'price_plus',
    periodInvoices: [{ id: 'in_a', refunded: false }],
    ...over,
  });
  const decide = (
    subscriptions: readonly SubscriptionFacts[],
    over: Partial<Parameters<typeof decidePlanTier>[0]> = {},
  ) =>
    decidePlanTier({
      subscriptions,
      refundReadyIds: new Set(),
      openHoldIds: new Set(),
      lapsedHoldIds: new Set(),
      currentTier: 'free',
      comped: false,
      priceTierMap: TIERS,
      eventSubscriptionId: null,
      eventGrant: null,
      ...over,
    });

  it.each([
    ['active', 'plus'],
    ['trialing', 'plus'],
    ['past_due', 'free'],
    ['unpaid', 'free'],
    ['paused', 'free'],
    ['incomplete', 'free'],
    ['canceled', 'free'],
    ['incomplete_expired', 'free'],
  ])('a %s subscription means %s', (status, tier) => {
    expect(decide([sub({ status })])).toMatchObject({ action: 'set', tier });
  });

  it('a proven-refunded period grants nothing; a period with no invoice only keeps', () => {
    expect(decide([sub({ periodInvoices: [{ id: 'in_a', refunded: true }] })])).toMatchObject({
      tier: 'free',
    });
    expect(decide([sub({ periodInvoices: [] })])).toEqual({
      action: 'set',
      tier: 'free',
      entitledIds: [],
    });
    expect(decide([sub({ periodInvoices: [] })], { currentTier: 'plus' })).toEqual({
      action: 'set',
      tier: 'plus',
      entitledIds: [],
    });
    expect(
      decide([
        sub({
          periodInvoices: [
            { id: 'in_a', refunded: true },
            { id: 'in_b', refunded: false },
          ],
        }),
      ]),
    ).toMatchObject({ tier: 'plus' });
  });

  it.each([
    ['free', 'price_plus', 'free'],
    ['plus', 'price_plus', 'plus'],
    ['plus', 'price_max', 'plus'],
    ['family', 'price_plus', 'plus'],
    ['family', 'price_max', 'family'],
  ] as const)('past_due on %s with %s carries %s', (currentTier, priceId, tier) => {
    expect(decide([sub({ status: 'past_due', priceId })], { currentTier })).toEqual({
      action: 'set',
      tier,
      entitledIds: [],
    });
  });

  it('an open refund hold keeps the tier and stops a paid subscription granting', () => {
    const held = { openHoldIds: new Set(['sub_a']) };
    expect(decide([sub()], { ...held, currentTier: 'plus' })).toEqual({
      action: 'set',
      tier: 'plus',
      entitledIds: [],
    });
    expect(decide([sub()], held)).toMatchObject({ tier: 'free', entitledIds: [] });
  });

  it('a lapsed refund hold carries no tier, while an open one still does', () => {
    const past = sub({ status: 'past_due', periodInvoices: [] });
    expect(
      decide([past], {
        currentTier: 'plus',
        openHoldIds: new Set(['sub_a']),
        lapsedHoldIds: new Set(['sub_a']),
      }),
    ).toEqual({ action: 'set', tier: 'free', entitledIds: [] });
    expect(decide([past], { currentTier: 'plus', openHoldIds: new Set(['sub_a']) })).toEqual({
      action: 'set',
      tier: 'plus',
      entitledIds: [],
    });
  });

  it('a held tier beside a different granted tier is mixed', () => {
    expect(decide([sub(), sub({ id: 'sub_b', status: 'past_due' })])).toEqual({
      action: 'set',
      tier: 'plus',
      entitledIds: ['sub_a'],
    });
    expect(
      decide([sub(), sub({ id: 'sub_b', status: 'past_due', priceId: 'price_max' })], {
        currentTier: 'family',
      }),
    ).toEqual({ action: 'hold', reason: 'mixed_tiers' });
  });

  it('the event own subscription pages only when it is held above the outcome', () => {
    const own = sub({ status: 'past_due', priceId: 'price_max' });
    const event = { eventSubscriptionId: 'sub_a' };
    expect(decide([own], { ...event, currentTier: 'plus' })).toEqual({
      action: 'hold',
      reason: 'current_period_unproven',
    });
    expect(decide([own], { ...event, currentTier: 'family' })).toMatchObject({
      action: 'set',
      tier: 'family',
    });
    expect(decide([own], { currentTier: 'plus' })).toMatchObject({ action: 'set', tier: 'plus' });
  });

  it('a refund-ready subscription never supplies a tier', () => {
    expect(decide([sub()], { refundReadyIds: new Set(['sub_a']) })).toEqual({
      action: 'set',
      tier: 'free',
      entitledIds: [],
    });
  });

  it('a comp is family whatever Stripe shows, including nothing', () => {
    expect(decide([], { comped: true })).toMatchObject({ action: 'set', tier: 'family' });
    expect(decide([sub()], { comped: true })).toMatchObject({ tier: 'family' });
  });

  it('none is free, one tier is that tier, and two tiers hold', () => {
    expect(decide([])).toEqual({ action: 'set', tier: 'free', entitledIds: [] });
    expect(decide([sub(), sub({ id: 'sub_b' })])).toEqual({
      action: 'set',
      tier: 'plus',
      entitledIds: ['sub_a', 'sub_b'],
    });
    expect(decide([sub(), sub({ id: 'sub_b', priceId: 'price_max' })])).toEqual({
      action: 'hold',
      reason: 'mixed_tiers',
    });
  });

  it('an unmapped price holds, unless it is the event own subscription', () => {
    const unmapped = sub({ priceId: 'price_gone' });
    expect(decide([unmapped])).toEqual({ action: 'hold', reason: 'unmapped_price' });
    expect(
      decide([unmapped], { eventGrant: { subscriptionId: 'sub_a', tier: 'family' } }),
    ).toMatchObject({ action: 'set', tier: 'family' });
    expect(
      decide([unmapped], { eventGrant: { subscriptionId: 'sub_other', tier: 'family' } }),
    ).toEqual({ action: 'hold', reason: 'unmapped_price' });
    expect(
      decide([sub({ status: 'past_due', priceId: 'price_gone' })], { currentTier: 'plus' }),
    ).toEqual({ action: 'hold', reason: 'unmapped_price' });
  });
});

describe('a full refund of the current period', () => {
  it('cancels that subscription, drops the plan, writes one row, and a replay does nothing', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_one', 'sub_one');
    buy(h.fake, 'one', familyId);
    const event = refundEvent(h.fake, 'ch_one');

    expect(await h.apply(event)).toEqual({ status: 'applied', tier: 'free' });
    expect(h.fake.deletes()).toEqual(['sub_one']);
    expect(await planTier(familyId)).toBe('free');
    const [row] = await afters(familyId, 'family_plan_updated');
    expect(row).toMatchObject({
      planTier: 'free',
      reason: 'refund',
      source: 'stripe',
      stripeEventId: event.id,
      subscriptionId: 'sub_one',
      subscriptionStatus: 'canceled',
      stripeCustomerId: 'cus_one',
    });
    expect(h.held).toEqual([]);
    expect(h.unresolved).toEqual([]);

    const callsBefore = h.fake.calls.length;
    expect(await h.apply(event)).toEqual({ status: 'duplicate' });
    expect(h.fake.calls.length).toBe(callsBefore);

    expect(await h.apply(deletedEvent(h.fake, 'sub_one'))).toEqual({
      status: 'kept',
      reason: 'not_entitled',
    });
    expect(await afters(familyId, 'family_plan_updated')).toHaveLength(1);
  });

  it('every Stripe request on the settle path sends the pinned API version', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_pin', 'sub_pin');
    buy(h.fake, 'pin', familyId);

    expect(await h.apply(refundEvent(h.fake, 'ch_pin'))).toEqual({
      status: 'applied',
      tier: 'free',
    });

    const paths = h.fake.calls.map((call) => call.path);
    expect(paths).toContain('/v1/invoice_payments');
    expect(paths).toContain('/v1/refunds');
    expect(h.fake.deletes()).toEqual(['sub_pin']);
    expect(h.fake.calls.map((call) => call.headers.get('stripe-version'))).toEqual(
      h.fake.calls.map(() => '2026-11-18.endive'),
    );
    const cancel = h.fake.calls.find((call) => call.method === 'DELETE');
    expect(cancel?.body).toBe('prorate=false&invoice_now=false');
  });

  it('a sibling whose own refund failed still counts as paid', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_failsib', 'sub_failsib');
    buy(h.fake, 'failsib', familyId);
    buy(h.fake, 'goodsib', familyId);
    h.fake.refund('ch_failsib', { status: 'failed' });

    expect(await h.apply(refundEvent(h.fake, 'ch_goodsib'))).toEqual({
      status: 'kept',
      reason: 'plan_unchanged',
    });
    expect(h.fake.deletes()).toEqual(['sub_goodsib']);
    expect(await planTier(familyId)).toBe('plus');
  });

  it('scenario 3: a refunded Max duplicate is cancelled and its late update cannot raise Plus', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_keep', 'sub_keep');
    buy(h.fake, 'keep', familyId);
    buy(h.fake, 'maxdup', familyId, { priceId: 'price_max' });

    expect(await h.apply(refundEvent(h.fake, 'ch_maxdup'))).toEqual({
      status: 'kept',
      reason: 'plan_unchanged',
    });
    expect(h.fake.deletes()).toEqual(['sub_maxdup']);
    expect(await planTier(familyId)).toBe('plus');

    const late = updatedEvent(h.fake, 'sub_maxdup', { status: 'active' });
    expect(await h.apply(late)).toEqual({ status: 'kept', reason: 'not_entitled' });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('scenario 3b: a refunded Plus duplicate on a Max family stays Max', async () => {
    const h = harness();
    const familyId = await family('family', 'cus_big', 'sub_big');
    buy(h.fake, 'big', familyId, { priceId: 'price_max' });
    buy(h.fake, 'small', familyId);

    expect(await h.apply(refundEvent(h.fake, 'ch_small'))).toEqual({
      status: 'kept',
      reason: 'plan_unchanged',
    });
    expect(h.fake.deletes()).toEqual(['sub_small']);
    expect(await planTier(familyId)).toBe('family');
  });

  describe.each([
    ['first then second', 'twoa', 'twob'],
    ['second then first', 'twob', 'twoa'],
  ])('scenario 2: both duplicates refunded, %s', (_label, first, second) => {
    it('ends with nothing billable and the family on Free', async () => {
      const h = harness();
      const familyId = await family('plus', 'cus_twoa', 'sub_twoa');
      buy(h.fake, 'twoa', familyId);
      buy(h.fake, 'twob', familyId);

      expect(await h.apply(refundEvent(h.fake, `ch_${first}`))).toEqual({
        status: 'kept',
        reason: 'plan_unchanged',
      });
      expect(await planTier(familyId)).toBe('plus');
      expect(await h.apply(refundEvent(h.fake, `ch_${second}`))).toEqual({
        status: 'applied',
        tier: 'free',
      });
      expect(h.fake.deletes()).toEqual([`sub_${first}`, `sub_${second}`]);
      expect(await planTier(familyId)).toBe('free');
    });
  });

  it('scenario 5 and 24: a refund of an older invoice ends nothing, even on an unmapped price', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_old', 'sub_old');
    buy(h.fake, 'old', familyId, { priceId: 'price_leftover_founding' });
    advancePeriod(h.fake, 'sub_old');

    expect(await h.apply(refundEvent(h.fake, 'ch_old'))).toEqual({
      status: 'kept',
      reason: 'older_invoice',
    });
    expect(h.fake.deletes()).toEqual([]);
    expect(await planTier(familyId)).toBe('plus');
    expect(await afters(familyId, 'billing_refunded')).toHaveLength(1);
    expect(h.held).toEqual([]);
  });

  it('scenario 6d: an older invoice on an unpaid subscription cancels nothing', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_unpaid', 'sub_unpaid');
    buy(h.fake, 'unpaid', familyId, { status: 'unpaid' });
    advancePeriod(h.fake, 'sub_unpaid');

    expect(await h.apply(refundEvent(h.fake, 'ch_unpaid'))).toEqual({
      status: 'kept',
      reason: 'older_invoice',
    });
    expect(h.fake.deletes()).toEqual([]);
  });

  it('scenario 7: an upgrade difference refunded holds and pages, with no cancel', async () => {
    const h = harness();
    const familyId = await family('family', 'cus_up', 'sub_up');
    buy(h.fake, 'up', familyId, { priceId: 'price_max' });
    h.fake.addPaidInvoice({
      subscriptionId: 'sub_up',
      invoiceId: 'in_up_diff',
      chargeId: 'ch_up_diff',
      paymentIntentId: 'pi_up_diff',
      periodStart: BOUGHT + DAY,
      periodEnd: BOUGHT + 365 * DAY,
      billingReason: 'subscription_update',
      proration: true,
      created: BOUGHT + DAY,
    });

    const event = refundEvent(h.fake, 'ch_up_diff');
    expect(await h.apply(event)).toMatchObject({
      status: 'unresolved',
      reason: 'period_partly_refunded',
    });
    expect(h.fake.deletes()).toEqual([]);
    expect(await planTier(familyId)).toBe('family');
    expect(h.held).toEqual([{ eventId: event.id, reason: 'period_partly_refunded' }]);
    expect(await isClaimed(event.id)).toBe(true);
  });

  it('scenario 7b: the original refunded while the difference stands also holds', async () => {
    const h = harness();
    const familyId = await family('family', 'cus_up2', 'sub_up2');
    buy(h.fake, 'up2', familyId, { priceId: 'price_max' });
    h.fake.addPaidInvoice({
      subscriptionId: 'sub_up2',
      invoiceId: 'in_up2_diff',
      chargeId: 'ch_up2_diff',
      paymentIntentId: 'pi_up2_diff',
      periodStart: BOUGHT + DAY,
      periodEnd: BOUGHT + 365 * DAY,
      billingReason: 'subscription_update',
      proration: true,
      created: BOUGHT + DAY,
    });

    expect(await h.apply(refundEvent(h.fake, 'ch_up2'))).toMatchObject({
      status: 'unresolved',
      reason: 'period_partly_refunded',
    });
    expect(h.fake.deletes()).toEqual([]);
    expect(await planTier(familyId)).toBe('family');
  });

  it('a replaced item on the covering invoice holds, with no cancel', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_swap', 'sub_swap');
    buy(h.fake, 'swap', familyId);
    h.fake.replaceItem('sub_swap', 'price_plus');

    expect(await h.apply(refundEvent(h.fake, 'ch_swap'))).toMatchObject({
      status: 'unresolved',
      reason: 'current_period_unproven',
    });
    expect(h.fake.deletes()).toEqual([]);
    expect(await planTier(familyId)).toBe('plus');
    expect(h.held).toHaveLength(1);
  });

  it('a truncated list cancels nothing, moves nothing, and pages', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_many', 'sub_many');
    buy(h.fake, 'many', familyId);
    h.fake.intercept(
      (call) => call.path === '/v1/subscriptions',
      (call) =>
        Response.json({
          object: 'list',
          url: call.path,
          has_more: true,
          data: [h.fake.subscriptions.get('sub_many')],
        }),
    );

    expect(await h.apply(refundEvent(h.fake, 'ch_many'))).toMatchObject({
      status: 'unresolved',
      reason: 'truncated',
    });
    expect(h.fake.deletes()).toEqual([]);
    expect(await planTier(familyId)).toBe('plus');
    expect(h.held).toHaveLength(1);
  });

  describe('another open invoice on the customer', () => {
    it.each([
      ['active', 'sub_sibling_a'],
      ['unpaid', 'sub_sibling_u'],
    ])('from an %s sibling: no cancel, held, paged', async (status, sibling) => {
      const h = harness();
      const familyId = await family('plus', 'cus_open', 'sub_open');
      buy(h.fake, 'open', familyId, { customer: 'cus_open' });
      h.fake.addSubscription({
        id: sibling,
        customer: 'cus_open',
        familyId,
        status,
        created: BOUGHT,
        periodStart: BOUGHT,
        periodEnd: BOUGHT + 365 * DAY,
      });
      h.fake.addOpenInvoice({
        id: 'in_sibling_open',
        customer: 'cus_open',
        subscriptionId: sibling,
        created: NOW_S - DAY,
      });

      expect(await h.apply(refundEvent(h.fake, 'ch_open'))).toMatchObject({
        status: 'unresolved',
        reason: 'cancel_would_stop_collection',
      });
      expect(h.fake.deletes()).toEqual([]);
      expect(h.held).toHaveLength(1);
    });

    it('positive control: an open invoice on another customer does not block', async () => {
      const h = harness();
      const familyId = await family('plus', 'cus_clear', 'sub_clear');
      buy(h.fake, 'clear', familyId);
      h.fake.addOpenInvoice({
        id: 'in_elsewhere',
        customer: 'cus_elsewhere',
        subscriptionId: null,
        created: NOW_S - DAY,
      });

      expect(await h.apply(refundEvent(h.fake, 'ch_clear'))).toEqual({
        status: 'applied',
        tier: 'free',
      });
      expect(h.fake.deletes()).toEqual(['sub_clear']);
    });
  });

  describe('the refund must have settled before anything is cancelled', () => {
    it.each(['failed', 'canceled'] as const)('%s: held, no cancel', async (status) => {
      const h = harness();
      const familyId = await family('plus', `cus_r${status}`, `sub_r${status}`);
      buy(h.fake, `r${status}`, familyId);

      const event = refundEvent(h.fake, `ch_r${status}`, { status });
      expect(await h.apply(event)).toMatchObject({
        status: 'unresolved',
        reason: 'refund_not_settled',
      });
      expect(h.fake.deletes()).toEqual([]);
      expect(await planTier(familyId)).toBe('plus');
      expect(await isClaimed(event.id)).toBe(true);
    });

    it('a failed refund replaced by a succeeded one cancels', async () => {
      const h = harness();
      const familyId = await family('plus', 'cus_second', 'sub_second');
      buy(h.fake, 'second', familyId);
      h.fake.refund('ch_second', { status: 'failed' });

      expect(await h.apply(refundEvent(h.fake, 'ch_second'))).toEqual({
        status: 'applied',
        tier: 'free',
      });
      expect(h.fake.deletes()).toEqual(['sub_second']);
    });

    it('pending returns retry unclaimed, then the flip to succeeded cancels and claims', async () => {
      const h = harness();
      const familyId = await family('plus', 'cus_pend', 'sub_pend');
      buy(h.fake, 'pend', familyId);
      const event = refundEvent(h.fake, 'ch_pend', { status: 'pending' });

      expect(await h.apply(event)).toMatchObject({ status: 'retry', reason: 'refund_pending' });
      expect(h.fake.deletes()).toEqual([]);
      expect(await isClaimed(event.id)).toBe(false);
      expect(h.pages).toEqual([]);

      const stored = h.fake.refunds.find((row) => row.charge === 'ch_pend');
      if (!stored) throw new Error('no refund');
      stored.status = 'succeeded';
      expect(await h.apply(event)).toEqual({ status: 'applied', tier: 'free' });
      expect(h.fake.deletes()).toEqual(['sub_pend']);
      expect(await isClaimed(event.id)).toBe(true);
    });

    it.each([
      ['pending', 'insufficient_funds'],
      ['requires_action', 'processing'],
    ] as const)('%s for %s pages hourly while it retries', async (status, pendingReason) => {
      const h = harness();
      const familyId = await family('plus', `cus_l${status}`, `sub_l${status}`);
      buy(h.fake, `l${status}`, familyId);
      const event = refundEvent(h.fake, `ch_l${status}`, { status, pendingReason });

      expect(await h.apply(event)).toMatchObject({ status: 'retry', reason: 'refund_pending' });
      expect(await h.apply(event)).toMatchObject({ status: 'retry', reason: 'refund_pending' });
      expect(h.pages).toHaveLength(1);
      expect(h.pages[0]).toContain('billing_refund_pending');
      expect(h.fake.deletes()).toEqual([]);
    });

    it('normal processing writes one held row after a day, and pages only then', async () => {
      const h = harness();
      const familyId = await family('plus', 'cus_slow', 'sub_slow');
      buy(h.fake, 'slow', familyId);
      const event = refundEvent(h.fake, 'ch_slow', { status: 'pending' }, NOW_S - 25 * 3600);

      expect(await h.apply(event)).toMatchObject({ status: 'retry', reason: 'refund_pending' });
      expect(await h.apply(event)).toMatchObject({ status: 'retry', reason: 'refund_pending' });
      const heldRows = await afters(familyId, 'billing_plan_unsettled');
      expect(heldRows).toHaveLength(1);
      expect(heldRows[0]).toMatchObject({ state: 'held', reason: 'refund_pending' });
      expect(h.held).toEqual([{ eventId: event.id, reason: 'refund_pending' }]);
    });
  });

  describe('the cancel itself', () => {
    it('a DELETE that fails but left the subscription cancelled proceeds', async () => {
      const h = harness();
      const familyId = await family('plus', 'cus_d1', 'sub_d1');
      buy(h.fake, 'd1', familyId);
      h.fake.intercept(
        (call) => call.method === 'DELETE',
        () => {
          const subscription = h.fake.subscriptions.get('sub_d1');
          if (subscription) subscription.status = 'canceled';
          return stripeError(500);
        },
        1,
      );

      expect(await h.apply(refundEvent(h.fake, 'ch_d1'))).toEqual({
        status: 'applied',
        tier: 'free',
      });
    });

    it('a DELETE that fails with the subscription still active retries, unclaimed and paged', async () => {
      const h = harness();
      const familyId = await family('plus', 'cus_d2', 'sub_d2');
      buy(h.fake, 'd2', familyId);
      h.fake.intercept(
        (call) => call.method === 'DELETE',
        () => stripeError(500),
      );

      const event = refundEvent(h.fake, 'ch_d2');
      expect(await h.apply(event)).toMatchObject({
        status: 'retry',
        reason: 'stripe_cancel_failed',
      });
      expect(await isClaimed(event.id)).toBe(false);
      expect(await planTier(familyId)).toBe('plus');
      expect(h.pages).toHaveLength(1);
      expect(h.pages[0]).toContain('call cancel');
    });
  });

  it('a subscription naming another family is held, never cancelled', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_mine', 'sub_mine');
    const other = await family('free');
    buy(h.fake, 'mine', familyId);
    buy(h.fake, 'theirs', other, { customer: 'cus_mine' });

    const event = refundEvent(h.fake, 'ch_theirs');
    const result = await h.apply({
      ...event,
      data: { object: { ...event.data.object, metadata: { familyId } } },
    });
    expect(result).toMatchObject({ status: 'unresolved', reason: 'subscription_unresolved' });
    expect(h.fake.deletes()).toEqual([]);
  });

  it('a lifetime comp keeps Max through a refund of a real purchase', async () => {
    const h = harness();
    const familyId = await family('family', 'cus_comp', 'sub_comp');
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'family_plan_comped',
      targetTable: 'families',
      targetId: familyId,
      after: { planTier: 'family', lifetime: true },
    });
    buy(h.fake, 'comp', familyId, { priceId: 'price_max' });

    await h.apply(refundEvent(h.fake, 'ch_comp'));
    expect(h.fake.deletes()).toEqual(['sub_comp']);
    expect(await planTier(familyId)).toBe('family');
    await h.apply(deletedEvent(h.fake, 'sub_comp'));
    expect(await planTier(familyId)).toBe('family');
  });

  it('a refund-ready subscription cannot supply a tier after the valid one is refunded', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_valid', 'sub_valid');
    buy(h.fake, 'valid', familyId);
    buy(h.fake, 'refused', familyId, { priceId: 'price_max' });
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'billing_refund_ready',
      targetTable: 'families',
      targetId: familyId,
      after: { subscriptionId: 'sub_refused', refund: 'ready' },
    });

    expect(await h.apply(refundEvent(h.fake, 'ch_valid'))).toEqual({
      status: 'applied',
      tier: 'free',
    });
    expect(h.fake.deletes()).toEqual(['sub_valid']);
  });
});

describe('lifecycle events follow what is still paid', () => {
  it('scenario 1: a duplicate purchase on two customers grants once each, with no page', async () => {
    const h = harness();
    const familyId = await family('free');
    buy(h.fake, 'first', familyId);
    expect(await h.apply(checkout(familyId, 'first'))).toEqual({ status: 'applied', tier: 'plus' });
    buy(h.fake, 'second2', familyId);
    expect(await h.apply(checkout(familyId, 'second2'))).toEqual({
      status: 'applied',
      tier: 'plus',
    });
    expect(h.held).toEqual([]);
  });

  it('scenario 1b: Plus and Max together hold on the first tier and page', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_mix1', 'sub_mix1');
    buy(h.fake, 'mix1', familyId);
    buy(h.fake, 'mix2', familyId, { priceId: 'price_max' });

    expect(await h.apply(checkout(familyId, 'mix2', 'family'))).toMatchObject({
      status: 'unresolved',
      reason: 'mixed_tiers',
    });
    expect(await planTier(familyId)).toBe('plus');
    expect(h.held).toHaveLength(1);
  });

  it('scenario 4: Max ended with Plus left moves the family to Plus', async () => {
    const h = harness();
    const familyId = await family('family', 'cus_m', 'sub_m');
    buy(h.fake, 'm', familyId, { priceId: 'price_max' });
    buy(h.fake, 'p', familyId);

    expect(await h.apply(deletedEvent(h.fake, 'sub_m'))).toEqual({
      status: 'applied',
      tier: 'plus',
    });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('scenario 4: Plus ended with Max left moves the family to Max', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_p2', 'sub_p2');
    buy(h.fake, 'p2', familyId);
    buy(h.fake, 'm2', familyId, { priceId: 'price_max' });

    expect(await h.apply(deletedEvent(h.fake, 'sub_p2'))).toEqual({
      status: 'applied',
      tier: 'family',
    });
  });

  it('positive control: a deletion with nothing else live drops to Free', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_last', 'sub_last');
    buy(h.fake, 'last', familyId);

    expect(await h.apply(deletedEvent(h.fake, 'sub_last'))).toEqual({
      status: 'applied',
      tier: 'free',
    });
  });

  it('scenario 6c: unpaid means Free, and paying brings the plan back with no marker', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_lapse', 'sub_lapse');
    buy(h.fake, 'lapse', familyId);
    const subscription = h.fake.subscriptions.get('sub_lapse');
    if (!subscription) throw new Error('no subscription');
    subscription.status = 'unpaid';

    expect(await h.apply(updatedEvent(h.fake, 'sub_lapse'))).toEqual({
      status: 'kept',
      reason: 'not_entitled',
    });
    expect(await planTier(familyId)).toBe('free');

    subscription.status = 'active';
    expect(await h.apply(invoicePaid(h.fake, 'in_lapse'))).toEqual({
      status: 'applied',
      tier: 'plus',
    });
    expect(await planTier(familyId)).toBe('plus');
    expect(await afters(familyId, 'billing_plan_unsettled')).toEqual([]);
  });

  it('scenario 10b: late grants after a refund change nothing, and a new purchase does', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_late', 'sub_late');
    buy(h.fake, 'late', familyId);
    await h.apply(refundEvent(h.fake, 'ch_late'));
    expect(await planTier(familyId)).toBe('free');

    expect(await h.apply(invoicePaid(h.fake, 'in_late'))).toEqual({
      status: 'kept',
      reason: 'not_entitled',
    });
    expect(await h.apply(checkout(familyId, 'late'))).toEqual({
      status: 'kept',
      reason: 'not_entitled',
    });
    expect(await planTier(familyId)).toBe('free');

    buy(h.fake, 'again', familyId);
    expect(await h.apply(checkout(familyId, 'again'))).toEqual({
      status: 'applied',
      tier: 'plus',
    });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('a tier move on a not-entitled event carries settledByEventId and no stripeEventId', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_nm', 'sub_nm');
    buy(h.fake, 'nm', familyId);
    const subscription = h.fake.subscriptions.get('sub_nm');
    if (!subscription) throw new Error('no subscription');
    subscription.status = 'unpaid';

    const event = updatedEvent(h.fake, 'sub_nm');
    await h.apply(event);
    const [row] = await afters(familyId, 'family_plan_updated');
    expect(row).toMatchObject({ planTier: 'free', settledByEventId: event.id, source: 'stripe' });
    expect(row).not.toHaveProperty('stripeEventId');
  });

  it('a second customer known only from an audit row keeps the family paid', async () => {
    const h = harness();
    const familyId = await family('free');
    buy(h.fake, 'hidden', familyId);
    h.fake.unindexed.add('sub_hidden');
    await h.apply(checkout(familyId, 'hidden'));
    buy(h.fake, 'stored', familyId);
    h.fake.unindexed.add('sub_stored');
    await h.apply(checkout(familyId, 'stored'));

    expect(await h.apply(deletedEvent(h.fake, 'sub_stored'))).toEqual({
      status: 'kept',
      reason: 'not_entitled',
    });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('positive control: with no audit row and no search hit, the family drops', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_seen', 'sub_seen');
    buy(h.fake, 'seen', familyId);
    buy(h.fake, 'unseen', familyId);
    h.fake.unindexed.add('sub_unseen');

    expect(await h.apply(deletedEvent(h.fake, 'sub_seen'))).toEqual({
      status: 'applied',
      tier: 'free',
    });
  });

  it('a paid manual invoice with nothing entitling holds; with a live subscription it follows it', async () => {
    const h = harness();
    const familyId = await family('free', 'cus_manual', null);
    const manual = {
      id: nextEventId('manual'),
      type: 'invoice.paid',
      created: NOW_S,
      data: {
        object: {
          id: 'in_manual',
          customer: 'cus_manual',
          metadata: { familyId, tier: 'plus' },
          lines: { data: [] },
        },
      },
    };
    expect(await h.apply(manual)).toMatchObject({
      status: 'unresolved',
      reason: 'no_subscription_on_event',
    });
    expect(await planTier(familyId)).toBe('free');

    buy(h.fake, 'manuallive', familyId, { customer: 'cus_manual' });
    const again = { ...manual, id: nextEventId('manual') };
    expect(await h.apply(again)).toEqual({ status: 'kept', reason: 'not_entitled' });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('a Payment Link purchase on an unmapped price gets the link tier, flag on and off', async () => {
    const options = { paymentLinkId: 'plink_1', paymentLinkTier: 'plus' as const };
    const afterWindow = Math.floor(new Date('2027-02-01T00:00:00Z').getTime() / 1000);
    for (const env of [FLAG_ON, FLAG_OFF]) {
      const h = harness(env);
      const suffix = env === FLAG_ON ? 'linkon' : 'linkoff';
      const familyId = await family('free');
      buy(h.fake, suffix, null, { priceId: 'price_link', customer: `cus_${suffix}` });
      const event = checkout(familyId, suffix, null, { payment_link: 'plink_1' }, afterWindow);
      const result = await applyStripeBillingEvent(event, db.database, TIERS, options, h.deps());
      expect(result).toEqual({ status: 'applied', tier: 'plus' });
      expect(await planTier(familyId)).toBe('plus');
    }
  });

  it('positive control: the same unmapped price on a non-link event grants nothing', async () => {
    const h = harness();
    const familyId = await family('free');
    buy(h.fake, 'nolink', familyId, { priceId: 'price_link' });
    expect(await h.apply(updatedEvent(h.fake, 'sub_nolink'))).toEqual({ status: 'no_tier' });
    expect(await planTier(familyId)).toBe('free');
  });

  it('a Payment Link subscription beside another, unmapped and not the event own, holds', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_pl', 'sub_pl');
    buy(h.fake, 'pl', familyId);
    buy(h.fake, 'linked', null, { priceId: 'price_link', customer: 'cus_pl' });

    expect(await h.apply(updatedEvent(h.fake, 'sub_pl'))).toMatchObject({
      status: 'unresolved',
      reason: 'unmapped_price',
    });
    expect(await planTier(familyId)).toBe('plus');
  });
});

describe('races', () => {
  it('scenario 13: a stale grant re-reads after a refund commits, and the family stays Free', async () => {
    const h = harness();
    const familyId = await family('free', 'cus_race', 'sub_race');
    buy(h.fake, 'race', familyId);
    const refund = refundEvent(h.fake, 'ch_race');
    unrefund(h.fake, 'ch_race');
    h.fake.beforeRead(
      (call) => call.path === '/v1/invoices',
      async () => {
        h.fake.refund('ch_race');
        expect(await h.apply(refund)).toEqual({ status: 'kept', reason: 'plan_unchanged' });
      },
    );

    expect(await h.apply(updatedEvent(h.fake, 'sub_race', { status: 'active' }))).toEqual({
      status: 'kept',
      reason: 'not_entitled',
    });
    expect(await planTier(familyId)).toBe('free');
    expect(h.fake.deletes()).toEqual(['sub_race']);
  });

  it('scenario 19: .deleted inside our cancel leaves one drop to Free', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_inside', 'sub_inside');
    buy(h.fake, 'inside', familyId);
    h.fake.duringDelete(async (id) => {
      await h.apply(deletedEvent(h.fake, id));
    });

    expect(await h.apply(refundEvent(h.fake, 'ch_inside'))).toEqual({
      status: 'kept',
      reason: 'plan_unchanged',
    });
    expect(await planTier(familyId)).toBe('free');
    const drops = (await afters(familyId, 'family_plan_updated')).filter(
      (row) => row.planTier === 'free',
    );
    expect(drops).toHaveLength(1);
  });

  it('a hold moves the version: a stale writer that read active cannot grant', async () => {
    const h = harness();
    const familyId = await family('free', 'cus_hv', 'sub_hv');
    buy(h.fake, 'hv', familyId);
    buy(h.fake, 'hvx', familyId, { customer: 'cus_hv', priceId: 'price_plus' });
    buy(h.fake, 'hvy', familyId, { customer: 'cus_hv', priceId: 'price_max' });
    const refund = refundEvent(h.fake, 'ch_hv');
    unrefund(h.fake, 'ch_hv');
    h.fake.beforeRead(
      (call) => call.path === '/v1/invoices',
      async () => {
        h.fake.refund('ch_hv');
        expect(await h.apply(refund)).toMatchObject({
          status: 'unresolved',
          reason: 'mixed_tiers',
        });
      },
    );

    const stale = await h.apply(updatedEvent(h.fake, 'sub_hv', { status: 'active' }));
    expect(stale).toMatchObject({ status: 'unresolved', reason: 'mixed_tiers' });
    expect(await planTier(familyId)).toBe('free');
    expect(h.fake.deletes()).toEqual(['sub_hv']);
  });

  describe('the refund-ready marker', () => {
    const GUARD = {
      ...FLAG_ON,
      STRIPE_PRICE_PLUS_ANNUAL: 'price_list',
    };

    function listPriceCreated(fake: FakeStripe, suffix: string) {
      const subscription = fake.subscriptions.get(`sub_${suffix}`);
      if (!subscription) throw new Error('no subscription');
      return {
        id: nextEventId('created'),
        type: 'customer.subscription.created',
        created: NOW_S,
        data: { object: { ...subscription } },
      };
    }

    it('committing during a settle stops the grant', async () => {
      const h = harness(GUARD);
      const familyId = await family('free', 'cus_gm', 'sub_gm');
      buy(h.fake, 'gm', familyId, { priceId: 'price_plus' });
      h.fake.beforeRead(
        (call) => call.path === '/v1/invoices',
        async () => {
          setPrice(h.fake, 'sub_gm', 'price_list');
          const marked = await h.apply(listPriceCreated(h.fake, 'gm'));
          expect(marked).toMatchObject({ status: 'refund_ready' });
          setPrice(h.fake, 'sub_gm', 'price_plus');
        },
      );

      const result = await h.apply(updatedEvent(h.fake, 'sub_gm'));
      expect(result).toEqual({ status: 'kept', reason: 'not_entitled' });
      expect(await planTier(familyId)).toBe('free');
    });

    it('a grant that committed first is removed by the re-settle', async () => {
      const h = harness(GUARD);
      const familyId = await family('free');
      buy(h.fake, 'gf', familyId, { priceId: 'price_plus' });
      expect(await h.apply(updatedEvent(h.fake, 'sub_gf'))).toEqual({
        status: 'applied',
        tier: 'plus',
      });

      setPrice(h.fake, 'sub_gf', 'price_list');
      const marked = await h.apply(listPriceCreated(h.fake, 'gf'));
      expect(marked).toMatchObject({ status: 'refund_ready' });
      expect(await planTier(familyId)).toBe('free');
    });
  });
});

describe('refusals, holds and the hourly count', () => {
  it('a 403 pages once across deliveries, is unclaimed, and a healthy delivery applies', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_403', 'sub_403');
    buy(h.fake, '403', familyId);
    h.fake.intercept(
      (call) => call.path === '/v1/invoice_payments',
      () => stripeError(403),
      2,
    );
    const event = refundEvent(h.fake, 'ch_403');

    expect(await h.apply(event)).toMatchObject({ status: 'retry', reason: 'stripe_refused' });
    expect(await h.apply(event)).toMatchObject({ status: 'retry', reason: 'stripe_refused' });
    expect(await isClaimed(event.id)).toBe(false);
    expect(h.pages).toHaveLength(1);
    expect(h.pages[0]).toContain('billing_stripe_refused');

    expect(await h.apply(event)).toEqual({ status: 'applied', tier: 'free' });
    expect(await isClaimed(event.id)).toBe(true);
  });

  it('a 403 on a checkout is also unclaimed and recoverable', async () => {
    const h = harness();
    const familyId = await family('free');
    buy(h.fake, 'co403', familyId);
    h.fake.intercept(
      (call) => call.path === '/v1/invoice_payments',
      () => stripeError(403),
      1,
    );
    const event = checkout(familyId, 'co403');

    expect(await h.apply(event)).toMatchObject({ status: 'retry', reason: 'stripe_refused' });
    expect(await isClaimed(event.id)).toBe(false);
    expect(await planTier(familyId)).toBe('free');
    expect(await h.apply(event)).toEqual({ status: 'applied', tier: 'plus' });
  });

  it('after 25 hours one held row across deliveries, counted until a healthy delivery clears it', async () => {
    const h = harness();
    const familyId = await family('free');
    buy(h.fake, 'old403', familyId);
    h.fake.intercept(
      (call) => call.path === '/v1/invoices',
      () => stripeError(403),
      2,
    );
    const event = checkout(familyId, 'old403', 'plus', {}, NOW_S - 25 * 3600);
    const before = (await planUnsettled()) ?? 0;

    await h.apply(event);
    await h.apply(event);
    const heldRows = await afters(familyId, 'billing_plan_unsettled');
    expect(heldRows).toHaveLength(1);
    expect(heldRows[0]).toMatchObject({
      state: 'held',
      reason: 'stripe_refused',
      stripeEventId: event.id,
      clearsOn: 'decision',
    });
    expect(await planUnsettled()).toBe(before + 1);

    expect(await h.apply(event)).toEqual({ status: 'applied', tier: 'plus' });
    const cleared = (await afters(familyId, 'billing_plan_unsettled')).filter(
      (row) => row.state === 'cleared',
    );
    expect(cleared).toEqual([expect.objectContaining({ clearsEventId: event.id })]);
    expect(await planUnsettled()).toBe(before);
  });

  it('a 404 on the charge the event named is a refusal, not "not tied"', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_404', 'sub_404');
    buy(h.fake, '404', familyId);
    const event = refundEvent(h.fake, 'ch_404');
    h.fake.charges.delete('ch_404');

    expect(await h.apply(event)).toMatchObject({ status: 'retry', reason: 'stripe_refused' });
    expect(await isClaimed(event.id)).toBe(false);
    expect(await planTier(familyId)).toBe('plus');
    expect(h.pages[0]).toContain('status 404');
  });

  it('a 404 on a remembered customer means gone, and the settle carries on', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_gone', 'sub_live404');
    buy(h.fake, 'live404', familyId, { customer: 'cus_live404' });
    h.fake.intercept(
      (call) => call.path === '/v1/subscriptions' && call.query.get('customer') === 'cus_gone',
      () => stripeError(404, 'resource_missing'),
    );

    const event = updatedEvent(h.fake, 'sub_live404');
    expect(await h.apply(event)).toEqual({ status: 'applied', tier: 'plus' });
  });

  it('a tier hold clears on the next settled decision', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_th', 'sub_th');
    buy(h.fake, 'th', familyId);
    buy(h.fake, 'th2', familyId, { priceId: 'price_max' });
    const event = checkout(familyId, 'th2', 'family');
    await h.apply(event);
    expect((await afters(familyId, 'billing_plan_unsettled'))[0]).toMatchObject({
      state: 'held',
      reason: 'mixed_tiers',
      clearsOn: 'decision',
    });

    await h.apply(deletedEvent(h.fake, 'sub_th2'));
    expect(
      (await afters(familyId, 'billing_plan_unsettled')).filter((row) => row.state === 'cleared'),
    ).toEqual([expect.objectContaining({ clearsEventId: event.id })]);
  });

  it('a refund hold ignores a later decision and clears when its subscription ends', async () => {
    const h = harness();
    const familyId = await family('family', 'cus_rh', 'sub_rh');
    buy(h.fake, 'rh', familyId, { priceId: 'price_max' });
    h.fake.addPaidInvoice({
      subscriptionId: 'sub_rh',
      invoiceId: 'in_rh_diff',
      chargeId: 'ch_rh_diff',
      paymentIntentId: 'pi_rh_diff',
      periodStart: BOUGHT + DAY,
      periodEnd: BOUGHT + 365 * DAY,
      billingReason: 'subscription_update',
      proration: true,
      created: BOUGHT + DAY,
    });
    const event = refundEvent(h.fake, 'ch_rh_diff');
    await h.apply(event);
    expect((await afters(familyId, 'billing_plan_unsettled'))[0]).toMatchObject({
      state: 'held',
      subscriptionId: 'sub_rh',
      clearsOn: 'subscription_ended',
    });

    await h.apply(updatedEvent(h.fake, 'sub_rh'));
    expect(
      (await afters(familyId, 'billing_plan_unsettled')).filter((row) => row.state === 'cleared'),
    ).toEqual([]);

    await h.apply(deletedEvent(h.fake, 'sub_rh'));
    expect(
      (await afters(familyId, 'billing_plan_unsettled')).filter((row) => row.state === 'cleared'),
    ).toEqual([expect.objectContaining({ clearsEventId: event.id })]);
  });

  it('a refund hold clears when its period rolls over', async () => {
    const h = harness();
    const familyId = await family('family', 'cus_rr', 'sub_rr');
    buy(h.fake, 'rr', familyId, { priceId: 'price_max' });
    h.fake.addPaidInvoice({
      subscriptionId: 'sub_rr',
      invoiceId: 'in_rr_diff',
      chargeId: 'ch_rr_diff',
      paymentIntentId: 'pi_rr_diff',
      periodStart: BOUGHT + DAY,
      periodEnd: BOUGHT + 365 * DAY,
      billingReason: 'subscription_update',
      proration: true,
      created: BOUGHT + DAY,
    });
    const event = refundEvent(h.fake, 'ch_rr_diff');
    await h.apply(event);

    advancePeriod(h.fake, 'sub_rr');
    const renewed = h.fake.subscriptions.get('sub_rr')?.items.data[0];
    if (!renewed) throw new Error('fixture');
    h.fake.addPaidInvoice({
      subscriptionId: 'sub_rr',
      invoiceId: 'in_rr_renewal',
      chargeId: 'ch_rr_renewal',
      paymentIntentId: 'pi_rr_renewal',
      periodStart: renewed.current_period_start,
      periodEnd: renewed.current_period_end,
      billingReason: 'subscription_cycle',
    });
    await h.apply(updatedEvent(h.fake, 'sub_rr'));
    expect(
      (await afters(familyId, 'billing_plan_unsettled')).filter((row) => row.state === 'cleared'),
    ).toEqual([expect.objectContaining({ clearsEventId: event.id })]);
  });

  it('reconcile with the flag off has no planUnsettled and main alert text', async () => {
    const familyId = await family('free', 'cus_recon');
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'family_plan_updated',
      targetTable: 'families',
      targetId: familyId,
      after: { planTier: 'plus', source: 'stripe' },
    });
    vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.invalid/ops');
    const posted: string[] = [];
    const result = await reconcileBillingTiers(db.database, FLAG_OFF, (async (
      _url: unknown,
      init?: RequestInit,
    ) => {
      posted.push(String(init?.body));
      return new Response('ok');
    }) as unknown as typeof fetch);
    vi.unstubAllEnvs();
    await db.database
      .update(schema.families)
      .set({ stripeCustomerId: null })
      .where(eq(schema.families.id, familyId));

    if (result.status !== 'checked') throw new Error('reconcile did not run');
    expect(result.mismatches).not.toHaveProperty('planUnsettled');
    expect(posted[0]).toMatch(
      /billing: plan_tier disagrees with Stripe\. free_despite_paid=\d+ paid_despite_revoke=\d+ paid_without_customer=\d+ revoke_unresolved=\d+\./,
    );
    expect(posted[0]).not.toContain('plan_unsettled');
  });
});

describe('only a paid period grants a tier', () => {
  function holdCancelOnRefund(h: ReturnType<typeof harness>, suffix: string) {
    h.fake.addOpenInvoice({
      id: `in_other_${suffix}`,
      customer: `cus_${suffix}`,
      subscriptionId: null,
      created: NOW_S,
    });
    return refundEvent(h.fake, `ch_${suffix}`);
  }

  function setStatus(fake: FakeStripe, subscriptionId: string, status: string): void {
    const subscription = fake.subscriptions.get(subscriptionId);
    if (!subscription) throw new Error(`no ${subscriptionId}`);
    subscription.status = status;
  }

  function payCurrentPeriod(
    fake: FakeStripe,
    subscriptionId: string,
    suffix: string,
    refunded = false,
  ): string {
    const item = fake.subscriptions.get(subscriptionId)?.items.data[0];
    if (!item) throw new Error(`no ${subscriptionId}`);
    const invoiceId = `in_paid_${suffix}`;
    fake.addPaidInvoice({
      subscriptionId,
      invoiceId,
      chargeId: `ch_paid_${suffix}`,
      paymentIntentId: `pi_paid_${suffix}`,
      periodStart: item.current_period_start,
      periodEnd: item.current_period_end,
      billingReason: 'subscription_cycle',
      refunded,
    });
    return invoiceId;
  }

  async function clearedHolds(familyId: string): Promise<unknown[]> {
    return (await afters(familyId, 'billing_plan_unsettled'))
      .filter((row) => row.state === 'cleared')
      .map((row) => row.clearsEventId);
  }

  it('finding 9: a refunded, then renewed-unpaid, past_due subscription cannot restore the plan, and only the refund pages', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_nine', 'sub_nine');
    buy(h.fake, 'nine', familyId);

    expect(await h.apply(holdCancelOnRefund(h, 'nine'))).toMatchObject({
      status: 'unresolved',
      reason: 'cancel_would_stop_collection',
    });
    expect(h.fake.deletes()).toEqual([]);

    await h.apply(updatedEvent(h.fake, 'sub_nine'));
    expect(await planTier(familyId)).toBe('free');

    advancePeriod(h.fake, 'sub_nine');
    setStatus(h.fake, 'sub_nine', 'past_due');
    const pagesBefore = h.held.length;
    const pastDue = updatedEvent(h.fake, 'sub_nine');

    expect(await h.apply(pastDue)).toEqual({ status: 'kept', reason: 'not_entitled' });
    expect(await planTier(familyId)).toBe('free');
    expect(h.held.slice(pagesBefore)).toEqual([]);
    expect(h.held.map((page) => page.reason)).toEqual(['cancel_would_stop_collection']);
    expect(await isClaimed(pastDue.id)).toBe(true);
  });

  it('a Plus family going past_due stays Plus with no page', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_late', 'sub_late');
    buy(h.fake, 'late', familyId);
    advancePeriod(h.fake, 'sub_late');
    setStatus(h.fake, 'sub_late', 'past_due');

    expect(await h.apply(updatedEvent(h.fake, 'sub_late'))).toEqual({
      status: 'kept',
      reason: 'not_entitled',
    });
    expect(await planTier(familyId)).toBe('plus');
    expect(h.held).toEqual([]);
  });

  it('an active subscription between renewal and payment keeps its tier with no page', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_gap', 'sub_gap');
    buy(h.fake, 'gap', familyId);
    advancePeriod(h.fake, 'sub_gap');

    await h.apply(updatedEvent(h.fake, 'sub_gap'));
    expect(await planTier(familyId)).toBe('plus');
    expect(h.held).toEqual([]);
  });

  it('an active subscription with no paid invoice does not raise a Free family, and pages', async () => {
    const h = harness();
    const familyId = await family('free', 'cus_nopay', null);
    buy(h.fake, 'nopay', familyId);
    advancePeriod(h.fake, 'sub_nopay');
    const event = updatedEvent(h.fake, 'sub_nopay');

    expect(await h.apply(event)).toMatchObject({
      status: 'unresolved',
      reason: 'current_period_unproven',
    });
    expect(await planTier(familyId)).toBe('free');
    expect(h.held).toEqual([{ eventId: event.id, reason: 'current_period_unproven' }]);
  });

  it('an upgrade whose difference is unpaid stays Plus', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_upg', 'sub_upg');
    buy(h.fake, 'upg', familyId);
    setPrice(h.fake, 'sub_upg', 'price_max');
    setStatus(h.fake, 'sub_upg', 'past_due');

    expect(await h.apply(updatedEvent(h.fake, 'sub_upg'))).toMatchObject({
      status: 'unresolved',
      reason: 'current_period_unproven',
    });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('finding 12: an item replaced with Max plus a full refund stays Plus on the next update', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_twelve', 'sub_twelve');
    buy(h.fake, 'twelve', familyId);
    h.fake.replaceItem('sub_twelve', 'price_max');

    expect(await h.apply(refundEvent(h.fake, 'ch_twelve'))).toMatchObject({
      status: 'unresolved',
      reason: 'current_period_unproven',
    });
    expect(h.fake.deletes()).toEqual([]);

    await h.apply(updatedEvent(h.fake, 'sub_twelve'));
    expect(await planTier(familyId)).toBe('plus');
  });

  it('an open refund hold on a subscription with a paid invoice does not raise the tier', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_heldup', 'sub_heldup');
    buy(h.fake, 'heldup', familyId);
    expect(await h.apply(refundEvent(h.fake, 'ch_heldup', { status: 'failed' }))).toMatchObject({
      status: 'unresolved',
      reason: 'refund_not_settled',
    });
    setPrice(h.fake, 'sub_heldup', 'price_max');

    expect(await h.apply(updatedEvent(h.fake, 'sub_heldup'))).toMatchObject({
      status: 'unresolved',
      reason: 'current_period_unproven',
    });
    expect(await planTier(familyId)).toBe('plus');
  });

  it('a refund hold clears on rollover only once the new period has a paid, unrefunded invoice', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_roll', 'sub_roll');
    buy(h.fake, 'roll', familyId);
    const refund = holdCancelOnRefund(h, 'roll');
    await h.apply(refund);
    await h.apply(updatedEvent(h.fake, 'sub_roll'));
    expect(await planTier(familyId)).toBe('free');

    advancePeriod(h.fake, 'sub_roll');
    await h.apply(updatedEvent(h.fake, 'sub_roll'));
    expect(await clearedHolds(familyId)).not.toContain(refund.id);
    expect(await planTier(familyId)).toBe('free');

    payCurrentPeriod(h.fake, 'sub_roll', 'roll_refunded', true);
    await h.apply(updatedEvent(h.fake, 'sub_roll'));
    expect(await clearedHolds(familyId)).not.toContain(refund.id);
    expect(await planTier(familyId)).toBe('free');

    const paid = payCurrentPeriod(h.fake, 'sub_roll', 'roll_paid');
    expect(await h.apply(invoicePaid(h.fake, paid))).toEqual({ status: 'applied', tier: 'plus' });
    expect(await clearedHolds(familyId)).toContain(refund.id);
    expect(await planTier(familyId)).toBe('plus');
  });

  it('a refund hold written during a long Stripe outage still clears on a paid rollover', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_outage', 'sub_outage');
    buy(h.fake, 'outage', familyId);
    h.fake.intercept(
      (call) => call.path === '/v1/subscriptions/search',
      () => stripeError(503),
    );
    const refund = refundEvent(h.fake, 'ch_outage', undefined, NOW_S - 2 * DAY);
    expect(await h.apply(refund)).toEqual({ status: 'retry', reason: 'stripe_unavailable' });
    h.fake.clearIntercepts();
    await h.apply(updatedEvent(h.fake, 'sub_outage'));
    expect(await planTier(familyId)).toBe('free');

    advancePeriod(h.fake, 'sub_outage');
    const paid = payCurrentPeriod(h.fake, 'sub_outage', 'outage_paid');

    expect(await h.apply(invoicePaid(h.fake, paid))).toEqual({ status: 'applied', tier: 'plus' });
    expect(await clearedHolds(familyId)).toContain(refund.id);
  });

  it('finding 10: a partly refunded covering invoice holds and is not cancelled', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_part', 'sub_part');
    buy(h.fake, 'part', familyId);
    const charge = h.fake.charges.get('ch_part');
    const payment = h.fake.invoicePayments.at(-1);
    if (!charge || !payment) throw new Error('fixture');
    h.fake.charges.set('ch_part_two', {
      ...charge,
      id: 'ch_part_two',
      payment_intent: 'pi_part_two',
    });
    h.fake.invoicePayments.push({
      ...payment,
      id: 'inpay_part_two',
      payment: { type: 'payment_intent', payment_intent: 'pi_part_two' },
    });

    expect(await h.apply(refundEvent(h.fake, 'ch_part'))).toMatchObject({
      status: 'unresolved',
      reason: 'period_partly_refunded',
    });
    expect(h.fake.deletes()).toEqual([]);
    expect(await planTier(familyId)).toBe('plus');
  });

  it('finding 10: a covering invoice missing from the period list holds and is not cancelled', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_gone', 'sub_gone');
    buy(h.fake, 'gone', familyId);
    h.fake.intercept(
      (call) => call.path === '/v1/invoices' && call.query.get('subscription') === 'sub_gone',
      (call) => Response.json({ object: 'list', url: call.path, has_more: false, data: [] }),
    );

    expect(await h.apply(refundEvent(h.fake, 'ch_gone'))).toMatchObject({
      status: 'unresolved',
      reason: 'period_partly_refunded',
    });
    expect(h.fake.deletes()).toEqual([]);
  });

  describe('a proven full refund moves the plan even when the cancel is held', () => {
    it('Plus goes to Free at once, with the plan row, the held row, one page and no DELETE', async () => {
      const h = harness();
      const familyId = await family('plus', 'cus_heldfree', 'sub_heldfree');
      buy(h.fake, 'heldfree', familyId);
      const event = holdCancelOnRefund(h, 'heldfree');

      expect(await h.apply(event)).toMatchObject({
        status: 'unresolved',
        reason: 'cancel_would_stop_collection',
      });
      expect(await planTier(familyId)).toBe('free');
      expect(await afters(familyId, 'family_plan_updated')).toEqual([
        expect.objectContaining({ planTier: 'free', stripeEventId: event.id, reason: 'refund' }),
      ]);
      expect(await afters(familyId, 'billing_plan_unsettled')).toEqual([
        expect.objectContaining({
          state: 'held',
          reason: 'cancel_would_stop_collection',
          stripeEventId: event.id,
          planTier: 'free',
        }),
      ]);
      expect(h.held).toEqual([
        { eventId: event.id, reason: 'cancel_would_stop_collection', planChanged: true },
      ]);
      expect(h.fake.deletes()).toEqual([]);

      vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.slack.test/ops');
      const bodies: string[] = [];
      await alertUnsettledBillingPlan(h.held[0] ?? { eventId: event.id, reason: 'missing' }, ((
        _url: string,
        init?: RequestInit,
      ) => {
        bodies.push(String(init?.body));
        return Promise.resolve(new Response('ok'));
      }) as typeof fetch);
      expect(bodies[0]).toContain('plan changed and the subscription is still live');
      expect(bodies[0]).not.toContain('left unchanged');
      vi.unstubAllEnvs();

      expect(await h.apply(event)).toEqual({ status: 'duplicate' });
      expect(h.held).toHaveLength(1);
      expect(await afters(familyId, 'family_plan_updated')).toHaveLength(1);
    });

    it('a second paid subscription sets the tier', async () => {
      const h = harness();
      const familyId = await family('family', 'cus_heldtwo', 'sub_heldtwo');
      buy(h.fake, 'heldtwo', familyId, { priceId: 'price_max' });
      buy(h.fake, 'heldtwo_plus', familyId, { customer: 'cus_heldtwo' });
      const event = holdCancelOnRefund(h, 'heldtwo');

      expect(await h.apply(event)).toMatchObject({ reason: 'cancel_would_stop_collection' });
      expect(await planTier(familyId)).toBe('plus');
      expect(await afters(familyId, 'family_plan_updated')).toEqual([
        expect.objectContaining({ planTier: 'plus' }),
      ]);
      expect(h.fake.deletes()).toEqual([]);
    });

    it('a tier already right writes no plan row', async () => {
      const h = harness();
      const familyId = await family('plus', 'cus_heldsame', 'sub_heldsame');
      buy(h.fake, 'heldsame', familyId);
      buy(h.fake, 'heldsame_two', familyId, { customer: 'cus_heldsame' });
      await h.apply(holdCancelOnRefund(h, 'heldsame'));

      expect(await planTier(familyId)).toBe('plus');
      expect(await afters(familyId, 'family_plan_updated')).toEqual([]);
      expect(h.held).toHaveLength(1);
    });

    it('a tier decision that itself holds leaves the tier and keeps the held row', async () => {
      const h = harness();
      const familyId = await family('plus', 'cus_heldmix', 'sub_heldmix');
      buy(h.fake, 'heldmix', familyId);
      buy(h.fake, 'heldmix_gone', familyId, { customer: 'cus_heldmix', priceId: 'price_gone' });
      const event = holdCancelOnRefund(h, 'heldmix');

      expect(await h.apply(event)).toMatchObject({ reason: 'cancel_would_stop_collection' });
      expect(await planTier(familyId)).toBe('plus');
      expect(await afters(familyId, 'family_plan_updated')).toEqual([]);
      expect(await afters(familyId, 'billing_plan_unsettled')).toEqual([
        expect.objectContaining({ state: 'held', reason: 'cancel_would_stop_collection' }),
      ]);
    });

    it.each([
      ['refund_not_settled', 'failed'],
      ['period_partly_refunded', 'succeeded'],
    ] as const)('a %s hold leaves the tier alone', async (reason, status) => {
      const h = harness();
      const suffix = `kept_${reason}`;
      const familyId = await family('plus', `cus_${suffix}`, `sub_${suffix}`);
      buy(h.fake, suffix, familyId);
      if (reason === 'period_partly_refunded') {
        h.fake.addPaidInvoice({
          subscriptionId: `sub_${suffix}`,
          invoiceId: `in_${suffix}_diff`,
          chargeId: `ch_${suffix}_diff`,
          paymentIntentId: `pi_${suffix}_diff`,
          periodStart: BOUGHT + DAY,
          periodEnd: BOUGHT + 365 * DAY,
          billingReason: 'subscription_update',
          proration: true,
          created: BOUGHT + DAY,
        });
      }

      expect(await h.apply(refundEvent(h.fake, `ch_${suffix}`, { status }))).toMatchObject({
        reason,
      });
      expect(await planTier(familyId)).toBe('plus');
      expect(await afters(familyId, 'family_plan_updated')).toEqual([]);
      expect(h.fake.deletes()).toEqual([]);
    });
  });

  describe('a refund hold cannot carry a tier past its period', () => {
    it('a rollover to past_due with nothing paid drops to Free, with no second page and the hold open', async () => {
      const h = harness();
      const familyId = await family('plus', 'cus_lapse', 'sub_lapse');
      buy(h.fake, 'lapse', familyId);
      const refund = refundEvent(h.fake, 'ch_lapse', { status: 'failed' });
      expect(await h.apply(refund)).toMatchObject({ reason: 'refund_not_settled' });

      setStatus(h.fake, 'sub_lapse', 'past_due');
      await h.apply(updatedEvent(h.fake, 'sub_lapse'));
      expect(await planTier(familyId)).toBe('plus');

      advancePeriod(h.fake, 'sub_lapse');
      expect(await h.apply(updatedEvent(h.fake, 'sub_lapse'))).toEqual({
        status: 'kept',
        reason: 'not_entitled',
      });
      expect(await planTier(familyId)).toBe('free');
      expect(await afters(familyId, 'family_plan_updated')).toEqual([
        expect.objectContaining({ planTier: 'free' }),
      ]);
      expect(h.held).toEqual([{ eventId: refund.id, reason: 'refund_not_settled' }]);
      expect(await clearedHolds(familyId)).toEqual([]);
    });

    it('a rollover with a paid invoice clears the hold and grants on that event', async () => {
      const h = harness();
      const familyId = await family('plus', 'cus_relief', 'sub_relief');
      buy(h.fake, 'relief', familyId);
      const refund = refundEvent(h.fake, 'ch_relief', { status: 'failed' });
      await h.apply(refund);
      advancePeriod(h.fake, 'sub_relief');
      setStatus(h.fake, 'sub_relief', 'past_due');
      await h.apply(updatedEvent(h.fake, 'sub_relief'));
      expect(await planTier(familyId)).toBe('free');
      const pagesBefore = h.held.length;

      setStatus(h.fake, 'sub_relief', 'active');
      const paid = payCurrentPeriod(h.fake, 'sub_relief', 'relief');
      expect(await h.apply(invoicePaid(h.fake, paid))).toEqual({ status: 'applied', tier: 'plus' });
      expect(await planTier(familyId)).toBe('plus');
      expect(await clearedHolds(familyId)).toEqual([refund.id]);
      expect(h.held).toHaveLength(pagesBefore);
    });
  });

  describe('positive controls: a real payment grants with no page', () => {
    it('a Free family first purchase, active with a paid invoice', async () => {
      const h = harness();
      const familyId = await family('free');
      buy(h.fake, 'first', familyId);

      expect(await h.apply(checkout(familyId, 'first'))).toEqual({
        status: 'applied',
        tier: 'plus',
      });
      expect(await planTier(familyId)).toBe('plus');
      expect(h.held).toEqual([]);
    });

    it('a trial with no invoice yet', async () => {
      const h = harness();
      const familyId = await family('free');
      h.fake.addSubscription({
        id: 'sub_trial',
        customer: 'cus_trial',
        familyId,
        status: 'trialing',
        created: BOUGHT,
        periodStart: BOUGHT,
        periodEnd: BOUGHT + 30 * DAY,
      });

      expect(await h.apply(checkout(familyId, 'trial'))).toEqual({
        status: 'applied',
        tier: 'plus',
      });
      expect(h.held).toEqual([]);
    });

    it('a $0 paid invoice, which Stripe records with no invoice payment', async () => {
      const h = harness();
      const familyId = await family('free');
      h.fake.addSubscription({
        id: 'sub_zero',
        customer: 'cus_zero',
        familyId,
        created: BOUGHT,
        periodStart: BOUGHT,
        periodEnd: BOUGHT + 365 * DAY,
      });
      h.fake.addPaidInvoice({
        subscriptionId: 'sub_zero',
        invoiceId: 'in_zero',
        chargeId: 'ch_zero',
        paymentIntentId: 'pi_zero',
        periodStart: BOUGHT,
        periodEnd: BOUGHT + 365 * DAY,
        amount: 0,
      });
      h.fake.invoicePayments.length = 0;

      expect(await h.apply(checkout(familyId, 'zero'))).toEqual({
        status: 'applied',
        tier: 'plus',
      });
      expect(h.held).toEqual([]);
    });
  });
});

describe('with the flag on a dispute never moves the plan', () => {
  // Stripe's Dispute object has no customer field: the family is found through the charge.
  function disputeEvent(
    chargeId: string,
    type = 'charge.dispute.created',
    status = 'needs_response',
  ) {
    return {
      id: nextEventId('dispute'),
      type,
      created: NOW_S,
      data: { object: { id: `dp_${chargeId}`, object: 'dispute', charge: chargeId, status } },
    };
  }

  async function expectPagedOnce(
    h: ReturnType<typeof harness>,
    familyId: string,
    event: ReturnType<typeof disputeEvent>,
    tier: PlanTier,
  ) {
    expect(await h.apply(event)).toEqual({
      status: 'unresolved',
      reason: 'dispute_needs_review',
      opsAlert: 'sent',
    });
    expect(await planTier(familyId)).toBe(tier);
    expect(h.fake.deletes()).toEqual([]);
    expect(await afters(familyId, 'family_plan_updated')).toEqual([]);
    expect(await afters(familyId, 'billing_refunded')).toEqual([]);
    expect(await afters(familyId, 'billing_revoke_unresolved')).toEqual([
      expect.objectContaining({
        reason: 'dispute_needs_review',
        stripeEventId: event.id,
        tierChanged: false,
      }),
    ]);
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'dispute_needs_review' }]);
    expect(await isClaimed(event.id)).toBe(true);

    expect(await h.apply(event)).toEqual({ status: 'duplicate' });
    expect(h.unresolved).toHaveLength(1);
    expect(await afters(familyId, 'billing_revoke_unresolved')).toHaveLength(1);
    expect(await planTier(familyId)).toBe(tier);
  }

  it.each([
    ['charge.dispute.created', 'needs_response'],
    ['charge.dispute.funds_withdrawn', 'needs_response'],
    ['charge.dispute.closed', 'lost'],
  ])(
    '%s (%s) on the family own ended subscription pages and keeps the plan',
    async (type, status) => {
      const h = harness();
      const suffix = `dtype_${type.split('.').at(-1)}`;
      const familyId = await family('plus', `cus_${suffix}`, `sub_${suffix}`);
      buy(h.fake, suffix, familyId, { status: 'canceled' });

      await expectPagedOnce(h, familyId, disputeEvent(`ch_${suffix}`, type, status), 'plus');
    },
  );

  it.each([
    ['active', 'a stored id', true],
    ['active', 'no stored id', false],
    ['past_due', 'a stored id', true],
    ['unpaid', 'a stored id', true],
  ] as const)('a %s subscription with %s keeps the plan', async (status, _label, stored) => {
    const h = harness();
    const suffix = `dlive_${status}_${stored}`;
    const familyId = await family('plus', `cus_${suffix}`, stored ? `sub_${suffix}` : null);
    buy(h.fake, suffix, familyId, { status });
    expect(h.fake.charges.get(`ch_${suffix}`)).not.toHaveProperty('invoice');

    await expectPagedOnce(h, familyId, disputeEvent(`ch_${suffix}`), 'plus');
    expect(h.fake.calls.map((call) => call.path)).toContain('/v1/invoice_payments');
    expect(h.fake.calls.map((call) => call.headers.get('stripe-version'))).toEqual(
      h.fake.calls.map(() => '2026-11-18.endive'),
    );
  });

  it('an old ended subscription, with no stored id and another paid one, keeps the plan', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_dold', null);
    buy(h.fake, 'dold', familyId, { customer: 'cus_dold', status: 'canceled' });
    buy(h.fake, 'dold_paid', familyId, { customer: 'cus_dold' });

    await expectPagedOnce(h, familyId, disputeEvent('ch_dold'), 'plus');
  });

  it('an ended subscription while the family has a different stored one keeps the plan', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_dother', 'sub_dother_live');
    buy(h.fake, 'dother', familyId, { customer: 'cus_dother', status: 'canceled' });
    buy(h.fake, 'dother_live', familyId, { customer: 'cus_dother' });

    await expectPagedOnce(h, familyId, disputeEvent('ch_dother'), 'plus');
  });

  it('a comped family with an ended subscription and no stored id keeps its plan', async () => {
    const h = harness();
    const familyId = await family('family', 'cus_dcomp', null);
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'family_plan_comped',
      targetTable: 'families',
      targetId: familyId,
      after: { planTier: 'family', lifetime: true },
    });
    buy(h.fake, 'dcomp', familyId, { status: 'canceled', priceId: 'price_max' });

    await expectPagedOnce(h, familyId, disputeEvent('ch_dcomp'), 'family');
  });

  it('a charge with no invoice link still reaches a person through its customer', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_dnone', null);
    buy(h.fake, 'dnone', familyId);
    const charge = h.fake.charges.get('ch_dnone');
    if (!charge) throw new Error('fixture');
    charge.payment_intent = null;

    await expectPagedOnce(h, familyId, disputeEvent('ch_dnone'), 'plus');
  });

  it('a Stripe 5xx retries, claims nothing, and changes nothing', async () => {
    const h = harness();
    const familyId = await family('plus', 'cus_d5xx', null);
    buy(h.fake, 'd5xx', familyId);
    h.fake.intercept(
      (call) => call.path === '/v1/invoice_payments',
      () => stripeError(503),
    );
    const event = disputeEvent('ch_d5xx');

    expect(await h.apply(event)).toEqual({ status: 'retry', reason: 'stripe_unavailable' });
    expect(await planTier(familyId)).toBe('plus');
    expect(await isClaimed(event.id)).toBe(false);
    expect(await afters(familyId, 'billing_revoke_unresolved')).toEqual([]);
    expect(h.unresolved).toEqual([]);
    expect(h.fake.deletes()).toEqual([]);
  });

  it('no family behind the charge is the no_family page, once', async () => {
    const h = harness();
    buy(h.fake, 'dnofam', null);
    const event = disputeEvent('ch_dnofam');

    expect(await h.apply(event)).toEqual({
      status: 'unresolved',
      reason: 'no_family',
      opsAlert: 'sent',
    });
    expect(await isClaimed(event.id)).toBe(true);
    expect(await h.apply(event)).toEqual({ status: 'duplicate' });
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'no_family' }]);
  });

  it('a full refund naming a family Hale no longer has pages once and does not throw', async () => {
    const h = harness();
    const gone = randomUUID();
    buy(h.fake, 'rerased', gone);
    const charge = h.fake.charges.get('ch_rerased');
    if (!charge) throw new Error('fixture');
    charge.metadata = { familyId: gone };
    charge.payment_intent = null;
    const event = refundEvent(h.fake, 'ch_rerased');

    expect(await h.apply(event)).toEqual({
      status: 'unresolved',
      reason: 'no_family',
      opsAlert: 'sent',
    });
    expect(h.fake.deletes()).toEqual([]);
    expect(await isClaimed(event.id)).toBe(true);
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'no_family' }]);

    expect(await h.apply(event)).toEqual({ status: 'duplicate' });
    expect(h.unresolved).toHaveLength(1);
  });

  it('a full refund of an erased family whose subscription is still linked pages and does not cancel', async () => {
    const h = harness();
    buy(h.fake, 'rerasedsub', randomUUID());
    const event = refundEvent(h.fake, 'ch_rerasedsub');

    expect(await h.apply(event)).toEqual({
      status: 'unresolved',
      reason: 'no_family',
      opsAlert: 'sent',
    });
    expect(h.fake.deletes()).toEqual([]);
    expect(await isClaimed(event.id)).toBe(true);
  });

  it('a family Stripe still names but Hale no longer has is the no_family page', async () => {
    const h = harness();
    buy(h.fake, 'derased', randomUUID());
    const event = disputeEvent('ch_derased');

    expect(await h.apply(event)).toEqual({
      status: 'unresolved',
      reason: 'no_family',
      opsAlert: 'sent',
    });
    expect(await isClaimed(event.id)).toBe(true);
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'no_family' }]);
  });
});

describe('flag off is main plus one claim', () => {
  function offHarness() {
    const h = harness(FLAG_OFF);
    vi.stubGlobal('fetch', h.fake.fetch);
    return h;
  }

  function assertNoNewReads(fake: FakeStripe) {
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.deletes()).toEqual([]);
    const paths = fake.calls.map((call) => call.path);
    expect(paths).not.toContain('/v1/invoice_payments');
    expect(paths).not.toContain('/v1/refunds');
    expect(fake.calls.every((call) => !call.headers.has('stripe-version'))).toBe(true);
  }

  it('a live subscription keeps the plan with main row and page, and the event is claimed', async () => {
    const h = offHarness();
    const familyId = await family('plus', 'cus_off', 'sub_off');
    buy(h.fake, 'off', familyId);
    const event = refundEvent(h.fake, 'ch_off');

    expect(await h.apply(event)).toMatchObject({
      status: 'unresolved',
      reason: 'subscription_unresolved',
    });
    expect(await planTier(familyId)).toBe('plus');
    expect(await afters(familyId, 'billing_revoke_unresolved')).toHaveLength(1);
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'subscription_unresolved' }]);
    expect(await isClaimed(event.id)).toBe(true);
    assertNoNewReads(h.fake);

    expect(await h.apply(event)).toEqual({ status: 'duplicate' });
    expect(h.unresolved).toHaveLength(1);
    expect(await afters(familyId, 'billing_revoke_unresolved')).toHaveLength(1);
  });

  it('no stored id still drops to Free, as main does', async () => {
    const h = offHarness();
    const familyId = await family('plus', 'cus_nostore', null);
    buy(h.fake, 'nostore', familyId);

    expect(await h.apply(refundEvent(h.fake, 'ch_nostore'))).toEqual({
      status: 'applied',
      tier: 'free',
    });
    assertNoNewReads(h.fake);
  });

  it('no family pages once and is claimed', async () => {
    const h = offHarness();
    buy(h.fake, 'nofam', null);
    const event = refundEvent(h.fake, 'ch_nofam');

    expect(await h.apply(event)).toMatchObject({ status: 'unresolved', reason: 'no_family' });
    expect(await isClaimed(event.id)).toBe(true);
    expect(await h.apply(event)).toEqual({ status: 'duplicate' });
    expect(h.unresolved).toEqual([{ eventId: event.id, reason: 'no_family' }]);
    assertNoNewReads(h.fake);
  });

  it('a dispute reads as on main and is not claimed on the unresolved path', async () => {
    const h = offHarness();
    const familyId = await family('plus', 'cus_dis', 'sub_dis');
    buy(h.fake, 'dis', familyId);
    const event = {
      id: nextEventId('dispute'),
      type: 'charge.dispute.created',
      created: NOW_S,
      data: {
        object: { id: 'dp_1', object: 'dispute', charge: 'ch_dis', customer: 'cus_dis' },
      },
    };

    expect(await h.apply(event)).toMatchObject({
      status: 'unresolved',
      reason: 'subscription_unresolved',
    });
    expect(await planTier(familyId)).toBe('plus');
    expect(await isClaimed(event.id)).toBe(false);
    expect(await afters(familyId, 'billing_revoke_unresolved')).toHaveLength(1);
    assertNoNewReads(h.fake);
  });

  it('a dispute with no stored id still drops to Free, the bug the flag fixes', async () => {
    const h = offHarness();
    const familyId = await family('plus', 'cus_disfree', null);
    buy(h.fake, 'disfree', familyId);
    const event = {
      id: nextEventId('dispute'),
      type: 'charge.dispute.created',
      created: NOW_S,
      data: {
        object: { id: 'dp_3', object: 'dispute', charge: 'ch_disfree', customer: 'cus_disfree' },
      },
    };

    expect(await h.apply(event)).toEqual({ status: 'applied', tier: 'free' });
    expect(await planTier(familyId)).toBe('free');
    assertNoNewReads(h.fake);
  });
});
