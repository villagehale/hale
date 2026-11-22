import { type BillingNoticeEventFacts, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpsPage, OpsPager } from '~/lib/monitoring/failure-page';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { applyStripeBillingEvent } from '~/lib/webhooks/stripe-billing-apply';
import { addsNoticeSubject, endedSubscriptionIds, mergeNoticeFacts } from './merge';
import { recordBillingNoticeIntent } from './record';

/**
 * VIL-735 · the webhook's half of a billing notice: one durable row, recorded only for a
 * live, post-arm event whose grant or refund really applied. Each redelivery case goes
 * through the real apply.
 */

const SINCE = '2026-11-22T15:00:00Z';
const NOW = new Date('2026-11-22T18:00:00Z');
const ARMED = { BILLING_THREAD_NOTICES_ENABLED: 'true', BILLING_THREAD_NOTICES_SINCE: SINCE };
const secs = (at: Date) => Math.floor(at.getTime() / 1000);
const minutesBefore = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

let db: TestDb;
let familyId: string;
let pages: OpsPage[];
let serial = 0;

const pager: OpsPager = {
  async page(page) {
    pages.push(page);
    return 'paged';
  },
};

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  serial += 1;
  pages = [];
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  ({ familyId } = await seedFamily(db.database));
  await db.database
    .update(schema.families)
    .set({ stripeCustomerId: `cus_family_${serial}` })
    .where(eq(schema.families.id, familyId));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function checkoutEvent(over: Record<string, unknown> = {}, objectOver = {}) {
  return {
    id: `evt_checkout_${serial}`,
    type: 'checkout.session.completed',
    livemode: true,
    created: secs(minutesBefore(1)),
    ...over,
    data: {
      object: {
        id: `cs_live_${serial}`,
        created: secs(minutesBefore(2)),
        payment_status: 'paid',
        customer: `cus_family_${serial}`,
        subscription: `sub_${serial}`,
        metadata: { familyId, tier: 'plus' },
        ...objectOver,
      },
    },
  };
}

function refundEvent(over: Record<string, unknown> = {}, objectOver = {}) {
  return {
    id: `evt_refund_${serial}`,
    type: 'charge.refunded',
    livemode: true,
    created: secs(minutesBefore(1)),
    ...over,
    data: {
      object: {
        id: `ch_${serial}`,
        amount: 15900,
        amount_refunded: 15900,
        refunded: true,
        currency: 'cad',
        customer: `cus_family_${serial}`,
        ...objectOver,
      },
    },
  };
}

function deletedEvent(over: Record<string, unknown> = {}, objectOver = {}) {
  return {
    id: `evt_deleted_${serial}`,
    type: 'customer.subscription.deleted',
    livemode: true,
    created: secs(minutesBefore(1)),
    ...over,
    data: {
      object: {
        id: `sub_${serial}`,
        customer: `cus_family_${serial}`,
        metadata: { familyId },
        cancellation_details: { reason: 'cancellation_requested' },
        items: { data: [{ price: { id: 'price_plus' } }] },
        ...objectOver,
      },
    },
  };
}

const record = (
  event: unknown,
  applied: Parameters<typeof recordBillingNoticeIntent>[2] = { status: 'applied', tier: 'plus' },
  env: Record<string, string | undefined> = ARMED,
  now: Date = NOW,
) => recordBillingNoticeIntent(db.database, event, applied, { env, now, pager });

const noticeRows = () =>
  db.database
    .select()
    .from(schema.billingNotices)
    .where(eq(schema.billingNotices.familyId, familyId));

describe('what records nothing', () => {
  it('flag off: no row and no query; the same event with the flag on records one row', async () => {
    const noQueries = new Proxy(
      {},
      {
        get: () => () => {
          throw new Error('a dark recorder queried the database');
        },
      },
    ) as unknown as typeof db.database;
    await expect(
      recordBillingNoticeIntent(
        noQueries,
        checkoutEvent(),
        { status: 'applied', tier: 'plus' },
        { env: {}, now: NOW, pager },
      ),
    ).resolves.toBe('dark');
    expect(await noticeRows()).toHaveLength(0);
    await expect(record(checkoutEvent())).resolves.toBe('recorded');
    expect(await noticeRows()).toHaveLength(1);
  });

  it('a Preview deploy records nothing', async () => {
    await expect(
      record(checkoutEvent(), undefined, { ...ARMED, VERCEL_ENV: 'preview' }),
    ).resolves.toBe('preview');
    expect(await noticeRows()).toHaveLength(0);
  });

  it('livemode false and a missing livemode record nothing; true records', async () => {
    await expect(record(checkoutEvent({ livemode: false }))).resolves.toBe('test_mode');
    await expect(record(checkoutEvent({ livemode: undefined }))).resolves.toBe('test_mode');
    expect(await noticeRows()).toHaveLength(0);
    await expect(record(checkoutEvent({ livemode: true }))).resolves.toBe('recorded');
  });

  it('an event created before or exactly at SINCE records nothing; one after it does', async () => {
    const at = new Date(SINCE);
    await expect(record(checkoutEvent({ created: secs(at) - 1 }))).resolves.toBe('before_arm');
    await expect(record(checkoutEvent({ created: secs(at) }))).resolves.toBe('before_arm');
    expect(await noticeRows()).toHaveLength(0);
    await expect(record(checkoutEvent({ created: secs(at) + 1 }))).resolves.toBe('recorded');
  });

  it.each([
    ['unset', undefined],
    ['a bare date', '2026-11-22'],
    ['carrying a trailing newline', `${SINCE}\n`],
  ])('SINCE %s is dark', async (_label, since) => {
    await expect(
      record(checkoutEvent(), undefined, { ...ARMED, BILLING_THREAD_NOTICES_SINCE: since }),
    ).resolves.toBe('dark');
    expect(await noticeRows()).toHaveLength(0);
  });

  it('an event 73 hours old records nothing; 71 hours old records', async () => {
    const later = new Date(NOW.getTime() + 72 * 3_600_000);
    await expect(
      record(
        checkoutEvent({ created: secs(new Date(later.getTime() - 73 * 3_600_000)) }),
        undefined,
        ARMED,
        later,
      ),
    ).resolves.toBe('stale_event');
    expect(await noticeRows()).toHaveLength(0);
    await expect(
      record(
        checkoutEvent({ created: secs(new Date(later.getTime() - 71 * 3_600_000)) }),
        undefined,
        ARMED,
        later,
      ),
    ).resolves.toBe('recorded');
  });

  it('an unpaid session records nothing', async () => {
    await expect(record(checkoutEvent({}, { payment_status: 'unpaid' }))).resolves.toBe('not_paid');
    expect(await noticeRows()).toHaveLength(0);
  });

  it('a checkout apply refused records nothing', async () => {
    for (const applied of [
      { status: 'refund_ready', opsAlert: 'sent' },
      { status: 'blocked' },
      { status: 'unknown_family' },
    ] as const) {
      await expect(record(checkoutEvent(), applied)).resolves.toBe('not_applied');
    }
    expect(await noticeRows()).toHaveLength(0);
  });

  it('a duplicate naming a family that does not exist answers no_family and does not throw', async () => {
    const event = checkoutEvent(
      {},
      { metadata: { familyId: '00000000-0000-4000-8000-00000000dead', tier: 'plus' } },
    );
    await expect(record(event, { status: 'duplicate' })).resolves.toBe('no_family');
    expect(await noticeRows()).toHaveLength(0);
  });
});

describe('idempotency', () => {
  it('the same event twice is one row and one claim', async () => {
    const event = checkoutEvent();
    await expect(record(event)).resolves.toBe('recorded');
    await expect(record(event)).resolves.toBe('duplicate');
    expect(await noticeRows()).toHaveLength(1);
  });

  it('two Stripe events for one session are one row', async () => {
    await expect(record(checkoutEvent({ id: `evt_a_${serial}` }))).resolves.toBe('recorded');
    await expect(record(checkoutEvent({ id: `evt_b_${serial}` }))).resolves.toBe('duplicate');
    const rows = await noticeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.facts.eventIds).toEqual([`evt_a_${serial}`]);
  });

  it('two partial refunds on one charge both count and the row holds the higher total', async () => {
    await expect(
      record(refundEvent({ id: `evt_r1_${serial}` }, { amount_refunded: 5000, refunded: false }), {
        status: 'no_tier',
      }),
    ).resolves.toBe('recorded');
    await expect(
      record(refundEvent({ id: `evt_r2_${serial}` }, { amount_refunded: 9000, refunded: false }), {
        status: 'no_tier',
      }),
    ).resolves.toBe('recorded');
    const rows = await noticeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.facts.refunds).toEqual([
      {
        chargeId: `ch_${serial}`,
        refundedMinor: 9000,
        chargeMinor: 15900,
        currency: 'cad',
        full: false,
      },
    ]);
  });

  it('a late, lower refund after a sent notice claims and changes nothing', async () => {
    await record(
      refundEvent({ id: `evt_r_high_${serial}` }, { amount_refunded: 9000, refunded: false }),
      {
        status: 'no_tier',
      },
    );
    await db.database
      .update(schema.billingNotices)
      .set({ status: 'sent' })
      .where(eq(schema.billingNotices.familyId, familyId));
    await expect(
      record(
        refundEvent({ id: `evt_r_low_${serial}` }, { amount_refunded: 5000, refunded: false }),
        {
          status: 'no_tier',
        },
      ),
    ).resolves.toBe('stale_refund');
    const rows = await noticeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('sent');
  });
});

describe('one row for a refund and a cancel', () => {
  it('holds the same merged facts in either order', async () => {
    const refund = refundEvent();
    const deleted = deletedEvent();
    await record(refund, { status: 'no_tier' });
    await record(deleted, { status: 'applied', tier: 'free' });
    const first = (await noticeRows())[0];

    serial += 1;
    ({ familyId } = await seedFamily(db.database));
    await db.database
      .update(schema.families)
      .set({ stripeCustomerId: `cus_family_${serial}` })
      .where(eq(schema.families.id, familyId));
    await record(deletedEvent(), { status: 'applied', tier: 'free' });
    await record(refundEvent(), { status: 'no_tier' });
    const rows = await noticeRows();

    expect(rows).toHaveLength(1);
    expect(rows[0]?.lane).toBe('plan_change');
    expect(rows[0]?.facts.ended).toEqual({ subscriptionId: `sub_${serial}`, why: 'cancelled' });
    expect(rows[0]?.facts.refunds?.[0]?.refundedMinor).toBe(15900);
    expect(first?.facts.ended?.why).toBe('cancelled');
    expect(first?.facts.refunds?.[0]?.refundedMinor).toBe(15900);
  });

  it('the settle window slides on a second event and stops at the ceiling', async () => {
    await record(refundEvent(), { status: 'no_tier' });
    const [created] = await noticeRows();
    expect(created?.nextTryAt).toEqual(new Date(NOW.getTime() + 10 * 60_000));

    const fiveLater = new Date(NOW.getTime() + 5 * 60_000);
    await record(
      deletedEvent({ created: secs(fiveLater) }),
      { status: 'applied', tier: 'free' },
      ARMED,
      fiveLater,
    );
    expect((await noticeRows())[0]?.nextTryAt).toEqual(new Date(fiveLater.getTime() + 10 * 60_000));

    await db.database
      .update(schema.billingNotices)
      .set({ createdAt: new Date(NOW.getTime() - 55 * 60_000) })
      .where(eq(schema.billingNotices.familyId, familyId));
    const later = new Date(NOW.getTime() + 6 * 60_000);
    await record(
      refundEvent(
        { id: `evt_r_ceiling_${serial}`, created: secs(later) },
        { id: `ch_two_${serial}` },
      ),
      { status: 'no_tier' },
      ARMED,
      later,
    );
    expect((await noticeRows())[0]?.nextTryAt).toEqual(new Date(NOW.getTime() + 5 * 60_000));
  });

  it('a first delivery 90 minutes late still gets the full ten-minute window', async () => {
    const created = secs(new Date(NOW.getTime() - 90 * 60_000));
    await record(refundEvent({ created }), { status: 'no_tier' });
    expect((await noticeRows())[0]?.nextTryAt).toEqual(new Date(NOW.getTime() + 10 * 60_000));
  });

  it('a merge that adds a new charge or ended subscription clears the stored recipient', async () => {
    await record(refundEvent(), { status: 'no_tier' });
    const { parentUserId } = await seedFamily(db.database, 'Other Family');
    await db.database
      .update(schema.billingNotices)
      .set({ parentUserId })
      .where(eq(schema.billingNotices.familyId, familyId));
    await record(deletedEvent(), { status: 'applied', tier: 'free' });
    expect((await noticeRows())[0]?.parentUserId).toBeNull();
  });

  it('a second subscription ending clears the stored recipient and keeps both ids', async () => {
    await record(deletedEvent());
    const [first] = await noticeRows();
    const { parentUserId } = await db.database
      .select({ parentUserId: schema.familyMembers.userId })
      .from(schema.familyMembers)
      .where(eq(schema.familyMembers.familyId, familyId))
      .then((rows) => rows[0] as { parentUserId: string });
    await db.database
      .update(schema.billingNotices)
      .set({ parentUserId })
      .where(eq(schema.billingNotices.id, first?.id as string));

    await record(deletedEvent({ id: `evt_deleted_again_${serial}` }));
    expect((await noticeRows())[0]?.parentUserId).toBe(parentUserId);

    await record(
      deletedEvent({ id: `evt_deleted_other_${serial}` }, { id: `sub_other_${serial}` }),
    );
    const [merged] = await noticeRows();
    expect(merged?.parentUserId).toBeNull();
    expect(endedSubscriptionIds(merged?.facts as BillingNoticeEventFacts).sort()).toEqual(
      [`sub_${serial}`, `sub_other_${serial}`].sort(),
    );
  });

  it('a held row from before a re-light drops instead of absorbing a new event', async () => {
    await record(refundEvent(), { status: 'no_tier' });
    const relit = new Date(NOW.getTime() + 60 * 60_000);
    await db.database
      .update(schema.billingNotices)
      .set({ lastEventAt: new Date(relit.getTime() - 60_000) })
      .where(eq(schema.billingNotices.familyId, familyId));
    const later = new Date(relit.getTime() + 60_000);
    await expect(
      record(
        deletedEvent({ created: secs(later) }),
        { status: 'applied', tier: 'free' },
        { ...ARMED, BILLING_THREAD_NOTICES_SINCE: relit.toISOString() },
        later,
      ),
    ).resolves.toBe('recorded');
    const rows = await noticeRows();
    expect(rows.map((r) => [r.status, r.dropReason]).sort()).toEqual([
      ['dropped', 'before_arm'],
      ['open', null],
    ]);
    const open = rows.find((r) => r.status === 'open');
    expect(open?.facts.refunds).toBeUndefined();
    expect(open?.facts.ended?.subscriptionId).toBe(`sub_${serial}`);
  });
});

describe('finding the family', () => {
  it('a refund with the revoke flag off records by Stripe customer, with no fetch', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(record(refundEvent(), { status: 'no_tier' })).resolves.toBe('recorded');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await noticeRows())[0]?.lane).toBe('plan_change');
  });

  it('a family id that is not a uuid is no family, not a thrown query', async () => {
    const event = refundEvent({}, { metadata: { familyId: 'not-a-uuid' } });
    await expect(record(event, { status: 'no_tier' })).resolves.toBe('no_family');
    expect(await noticeRows()).toHaveLength(0);
  });

  it('a refund whose customer matches no family records nothing', async () => {
    await expect(
      record(refundEvent({}, { customer: 'cus_unknown' }), { status: 'no_tier' }),
    ).resolves.toBe('no_family');
    expect(await noticeRows()).toHaveLength(0);
  });
});

describe('a redelivery proves the first outcome through the real apply', () => {
  const priceMap = { price_plus: 'plus' } as const;
  const applyDeps = (over = {}) => ({
    now: NOW,
    env: { STRIPE_BILLING_REVOKE_ENABLED: 'true' } as Record<string, string | undefined>,
    chargeLookup: null,
    onUnresolvedRevoke: async () => 'sent' as const,
    onDisallowedPrice: async () => 'sent' as const,
    ...over,
  });
  const apply = (event: unknown, deps = applyDeps()) =>
    applyStripeBillingEvent(event, db.database, priceMap, {}, deps);

  it('a refund first unresolved records nothing', async () => {
    await db.database
      .update(schema.families)
      .set({ stripeSubscriptionId: `sub_on_file_${serial}`, planTier: 'plus' })
      .where(eq(schema.families.id, familyId));
    const event = refundEvent();
    expect((await apply(event)).status).toBe('unresolved');
    expect((await apply(event)).status).toBe('duplicate');
    await expect(record(event, { status: 'duplicate' })).resolves.toBe('not_applied');
    expect(await noticeRows()).toHaveLength(0);
  });

  it('a deletion of a blocked subscription records nothing on redelivery', async () => {
    const event = deletedEvent();
    const deps = applyDeps({ subscriptionBlocked: async () => true, env: {} });
    expect((await apply(event, deps)).status).toBe('blocked');
    expect((await apply(event, deps)).status).toBe('duplicate');
    await expect(record(event, { status: 'duplicate' })).resolves.toBe('not_applied');
    expect(await noticeRows()).toHaveLength(0);
  });

  it('a refund-ready session records nothing on redelivery', async () => {
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'billing_refund_ready',
      targetTable: 'families',
      targetId: familyId,
      after: { stripeEventId: `evt_checkout_${serial}`, refund: 'ready' },
    });
    await expect(record(checkoutEvent(), { status: 'duplicate' })).resolves.toBe('not_applied');
    expect(await noticeRows()).toHaveLength(0);
  });

  it('a refund first kept records on its redelivery', async () => {
    await db.database
      .update(schema.families)
      .set({ stripeSubscriptionId: `sub_${serial}`, planTier: 'plus' })
      .where(eq(schema.families.id, familyId));
    const event = refundEvent({}, { subscription: { id: `sub_${serial}`, status: 'active' } });
    expect((await apply(event)).status).toBe('kept');
    expect((await apply(event)).status).toBe('duplicate');
    await expect(record(event, { status: 'duplicate' })).resolves.toBe('recorded');
    expect((await noticeRows())[0]?.facts.refunds?.[0]?.chargeId).toBe(`ch_${serial}`);
  });

  it('an applied checkout whose first record threw records on its redelivery, with the granted tier', async () => {
    const event = checkoutEvent();
    expect((await apply(event, applyDeps({ env: {} }))).status).toBe('applied');
    expect((await apply(event, applyDeps({ env: {} }))).status).toBe('duplicate');
    await expect(record(event, { status: 'duplicate' })).resolves.toBe('recorded');
    const [row] = await noticeRows();
    expect(row?.lane).toBe('payment');
    expect(row?.facts.sessionTier).toBe('plus');
    expect(row?.facts.subscriptionId).toBe(`sub_${serial}`);
  });

  it('a duplicate with no audit row at all records nothing', async () => {
    await expect(record(deletedEvent(), { status: 'duplicate' })).resolves.toBe('not_applied');
    expect(await noticeRows()).toHaveLength(0);
  });
});

describe('a write that throws', () => {
  it('pages #ops once with unrecorded and rethrows, so Stripe retries', async () => {
    const boom = new Proxy(db.database, {
      get(target, prop, receiver) {
        if (prop === 'transaction') {
          return async () => {
            throw new Error('db down');
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    await expect(
      recordBillingNoticeIntent(
        boom,
        checkoutEvent(),
        { status: 'applied', tier: 'plus' },
        { env: ARMED, now: NOW, pager },
      ),
    ).rejects.toThrow('db down');
    expect(pages).toEqual([
      {
        site: 'billing_notice_unsent',
        ref: familyId,
        facts: { lane: 'payment', reason: 'unrecorded' },
      },
    ]);
    expect(await noticeRows()).toHaveLength(0);
  });
});

describe('the billing_notices migration', () => {
  it('applies twice, and holds one open row per family and lane', async () => {
    await db.applyMigration('0260_billing_notices.sql');
    const row = {
      familyId,
      lane: 'plan_change' as const,
      facts: { eventIds: ['evt_a'] },
      lastEventAt: NOW,
      nextTryAt: NOW,
    };
    await db.database.insert(schema.billingNotices).values(row);
    await expect(db.database.insert(schema.billingNotices).values(row)).rejects.toThrow();
    // Positive control: the index is per status and per lane, not per family.
    await db.database.insert(schema.billingNotices).values({ ...row, status: 'sent' });
    await db.database.insert(schema.billingNotices).values({ ...row, lane: 'payment' });
    expect(await noticeRows()).toHaveLength(3);
  });
});

describe('mergeNoticeFacts', () => {
  const refund = (chargeId: string, refundedMinor: number) => ({
    chargeId,
    refundedMinor,
    chargeMinor: 15900,
    currency: 'cad',
    full: refundedMinor === 15900,
  });

  it('does not depend on arrival order', () => {
    const a = {
      eventIds: ['evt_1'],
      refunds: [refund('ch_1', 5000)],
    };
    const b = {
      eventIds: ['evt_2'],
      ended: { subscriptionId: 'sub_1', why: 'cancelled' as const },
      refunds: [refund('ch_1', 15900), refund('ch_2', 200)],
    };
    const ab = mergeNoticeFacts(a, b);
    const ba = mergeNoticeFacts(b, a);
    expect(ab.ended).toEqual({ subscriptionId: 'sub_1', why: 'cancelled' });
    expect(ba.ended).toEqual(ab.ended);
    expect([...ab.eventIds].sort()).toEqual(['evt_1', 'evt_2']);
    const byCharge = (facts: typeof ab) =>
      Object.fromEntries((facts.refunds ?? []).map((r) => [r.chargeId, r.refundedMinor]));
    expect(byCharge(ab)).toEqual({ ch_1: 15900, ch_2: 200 });
    expect(byCharge(ba)).toEqual({ ch_1: 15900, ch_2: 200 });
  });

  it('keeps a subscription id the drain resolved when the higher total arrives', () => {
    const merged = mergeNoticeFacts(
      { eventIds: ['evt_1'], refunds: [{ ...refund('ch_1', 5000), subscriptionId: 'sub_1' }] },
      { eventIds: ['evt_2'], refunds: [refund('ch_1', 9000)] },
    );
    expect(merged.refunds).toEqual([{ ...refund('ch_1', 9000), subscriptionId: 'sub_1' }]);
  });

  it('two ended subscriptions: both stay named, in either order, and a third adds nothing new', () => {
    const a = { eventIds: ['evt_1'], ended: { subscriptionId: 'sub_1', why: 'cancelled' as const } };
    const b = { eventIds: ['evt_2'], ended: { subscriptionId: 'sub_2', why: 'cancelled' as const } };
    const ab = mergeNoticeFacts(a, b);
    const ba = mergeNoticeFacts(b, a);
    expect(endedSubscriptionIds(ab).sort()).toEqual(['sub_1', 'sub_2']);
    expect(endedSubscriptionIds(ba).sort()).toEqual(['sub_1', 'sub_2']);
    expect(addsNoticeSubject(a, b)).toBe(true);
    expect(addsNoticeSubject(ab, b)).toBe(false);
    expect(addsNoticeSubject(a, { ...a, eventIds: ['evt_3'] })).toBe(false);
  });

  it('two subscriptions that ended for different reasons state no reason', () => {
    const merged = mergeNoticeFacts(
      { eventIds: ['evt_1'], ended: { subscriptionId: 'sub_1', why: 'cancelled' } },
      { eventIds: ['evt_2'], ended: { subscriptionId: 'sub_2', why: 'payment_failed' } },
    );
    expect(merged.ended?.why).toBeNull();
    const same = mergeNoticeFacts(
      { eventIds: ['evt_1'], ended: { subscriptionId: 'sub_1', why: 'cancelled' } },
      { eventIds: ['evt_2'], ended: { subscriptionId: 'sub_2', why: 'cancelled' } },
    );
    expect(same.ended?.why).toBe('cancelled');
  });

  it('marks two different subscriptions in the payment lane', () => {
    const merged = mergeNoticeFacts(
      { eventIds: ['evt_1'], sessionTier: 'plus', subscriptionId: 'sub_1' },
      { eventIds: ['evt_2'], sessionTier: 'plus', subscriptionId: 'sub_2' },
    );
    expect(merged.conflictingPayment).toBe(true);
    expect(merged.subscriptionId).toBe('sub_1');
  });
});
