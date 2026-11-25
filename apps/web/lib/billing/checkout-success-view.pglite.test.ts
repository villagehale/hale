import type { Database } from '@hale/db';
import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LinqSendError } from '~/lib/channel/linq/transport';
import { encryptString } from '~/lib/crypto/string-cipher';
import { pageOps } from '~/lib/monitoring/failure-page';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { applyStripeBillingEvent } from '~/lib/webhooks/stripe-billing-apply';
import {
  alreadyPaidParentHasThread,
  hasOneToOneThread,
  resolveCheckoutPayer,
} from './checkout-payer';
import { type CheckoutViewDeps, checkoutViewFromSession } from './checkout-success-view';

const PRICE_ENV = { STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD: 'price_plus' };
const PRICE_MAP = { price_plus: 'plus' as const };
const NO_NOTICES: Record<string, string | undefined> = {};
const NO_DIRECT_CHAT = async (_phone: string): Promise<string | null> => null;
const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
const PARENT_PHONE = '+14165550101';

let test: TestDb;
let nextId = 0;

beforeAll(async () => {
  test = await createTestDb();
});

afterAll(async () => {
  await test.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', ENCRYPTION_KEY);
});

function uniq(prefix: string): string {
  nextId += 1;
  return `${prefix}_${nextId}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function untouchable(): Database {
  return new Proxy({} as Database, {
    get() {
      throw new Error('the database must not be touched');
    },
  });
}

interface Purchase {
  familyId: string;
  sessionId: string;
  subscriptionId: string;
  created: number;
  subscriptionCreated: number;
  tier?: 'plus' | 'family';
  subscriptionStatus?: string;
  expiresAt?: number;
  paymentStatus?: string;
  status?: string;
}

function paidSession(p: Purchase) {
  return {
    id: p.sessionId,
    status: p.status ?? 'complete',
    payment_status: p.paymentStatus ?? 'paid',
    created: p.created,
    expires_at: p.expiresAt ?? p.created + 24 * 3600,
    client_reference_id: p.familyId,
    amount_total: 5900,
    currency: 'cad',
    customer: `cus_${p.familyId}`,
    metadata: { familyId: p.familyId, tier: p.tier ?? 'plus', priceId: 'price_plus' },
    subscription: {
      id: p.subscriptionId,
      created: p.subscriptionCreated,
      status: p.subscriptionStatus ?? 'active',
    },
  };
}

function view(p: Purchase, deps: Partial<CheckoutViewDeps> = {}) {
  const pager = deps.page ?? vi.fn().mockResolvedValue('paged');
  return checkoutViewFromSession(paidSession(p), p.tier ?? 'plus', {
    database: () => test.database,
    env: NO_NOTICES,
    findDirectChat: NO_DIRECT_CHAT,
    ...deps,
    page: pager,
  });
}

async function applyEvent(event: unknown, env: Record<string, string> = PRICE_ENV) {
  return applyStripeBillingEvent(
    event,
    test.database,
    PRICE_MAP,
    {},
    {
      env,
      chargeLookup: null,
      onDisallowedPrice: async () => 'sent',
    },
  );
}

function completedEvent(p: Purchase) {
  return {
    id: uniq('evt_session'),
    type: 'checkout.session.completed',
    created: nowSeconds(),
    data: {
      object: {
        id: p.sessionId,
        customer: `cus_${p.familyId}`,
        subscription: p.subscriptionId,
        client_reference_id: p.familyId,
        metadata: { familyId: p.familyId, tier: p.tier ?? 'plus', priceId: 'price_plus' },
      },
    },
  };
}

function subscriptionEvent(p: Purchase, type = 'customer.subscription.created') {
  return {
    id: uniq('evt_sub'),
    type,
    created: nowSeconds(),
    data: {
      object: {
        id: p.subscriptionId,
        customer: `cus_${p.familyId}`,
        metadata: { familyId: p.familyId, tier: p.tier ?? 'plus' },
        items: { data: [{ price: { id: 'price_plus' } }] },
      },
    },
  };
}

function invoiceEvent(p: Purchase) {
  return {
    id: uniq('evt_inv'),
    type: 'invoice.paid',
    created: nowSeconds(),
    data: {
      object: {
        id: uniq('in'),
        customer: `cus_${p.familyId}`,
        subscription: p.subscriptionId,
        metadata: { familyId: p.familyId, tier: p.tier ?? 'plus' },
        lines: { data: [{ price: { id: 'price_plus' } }] },
      },
    },
  };
}

async function startCheckout(familyId: string, actor: string, createdSeconds: number) {
  await test.database.insert(schema.auditLog).values({
    familyId,
    actor,
    actionTaken: 'billing_checkout_started',
    targetTable: 'families',
    targetId: familyId,
    after: { tier: 'plus' },
    occurredAt: new Date((createdSeconds + 2) * 1000),
  });
}

async function planRow(familyId: string, tier: 'free' | 'plus' | 'family', atSeconds: number) {
  await test.database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'family_plan_updated',
    targetTable: 'families',
    targetId: familyId,
    after: { planTier: tier, source: 'stripe', stripeEventId: uniq('evt_seeded') },
    occurredAt: new Date(atSeconds * 1000),
  });
}

async function setPlan(familyId: string, planTier: 'free' | 'plus' | 'family') {
  await test.database
    .update(schema.families)
    .set({ planTier })
    .where(eq(schema.families.id, familyId));
}

async function inbound(
  familyId: string,
  parentUserId: string,
  over: Partial<typeof schema.channelMessages.$inferInsert> = {},
) {
  await test.database.insert(schema.channelMessages).values({
    familyId,
    parentUserId,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    status: 'delivered',
    providerChatId: uniq('chat'),
    inGroup: false,
    ...over,
  });
}

async function verifiedChannel(familyId: string, userId: string) {
  const [row] = await test.database
    .insert(schema.parentChannels)
    .values({
      userId,
      familyId,
      phoneE164Encrypted: encryptString(PARENT_PHONE),
      phoneE164Hash: uniq('hash'),
      verifiedAt: new Date(),
    })
    .returning({ id: schema.parentChannels.id });
  if (!row) throw new Error('channel insert returned nothing');
  return row.id;
}

async function coParent(familyId: string, name: string | null = 'Sam Coparent') {
  const [user] = await test.database
    .insert(schema.users)
    .values({ email: `${uniq('coparent')}@example.test`, name })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('user insert returned nothing');
  await test.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user.id, role: 'co_parent' });
  return user.id;
}

async function setName(userId: string, name: string | null) {
  await test.database.update(schema.users).set({ name }).where(eq(schema.users.id, userId));
}

function purchase(familyId: string, over: Partial<Purchase> = {}): Purchase {
  const created = nowSeconds() - 30;
  return {
    familyId,
    sessionId: `cs_test_${uniq('view')}`,
    subscriptionId: uniq('sub'),
    created,
    subscriptionCreated: created + 10,
    ...over,
  };
}

/** A family whose payer has their own thread, with this purchase already applied. */
async function activeFamily(name = 'Riley Parent') {
  const { familyId, parentUserId } = await seedFamily(test.database);
  await setName(parentUserId, name);
  await inbound(familyId, parentUserId);
  const p = purchase(familyId);
  await startCheckout(familyId, parentUserId, p.created);
  expect(await applyEvent(completedEvent(p))).toMatchObject({ status: 'applied' });
  return { familyId, parentUserId, p };
}

describe('checkoutViewFromSession on real billing rows', () => {
  it('shows a first purchase whose webhook already landed as the family plan', async () => {
    const { p } = await activeFamily();
    expect(await view(p)).toEqual({
      state: 'plan_active',
      checkInDue: false,
    });
  });

  it('stays on the family plan after every event of one purchase', async () => {
    const { p } = await activeFamily();
    expect(await applyEvent(subscriptionEvent(p))).toMatchObject({ status: 'applied' });
    expect(await applyEvent(invoiceEvent(p))).toMatchObject({ status: 'applied' });
    expect(await applyEvent(subscriptionEvent(p, 'customer.subscription.updated'))).toMatchObject({
      status: 'applied',
    });
    expect(await view(p)).toMatchObject({ state: 'plan_active' });
  });

  /** A first purchase an hour old, on the rows its webhook wrote. */
  async function familyThatAlreadyPaid() {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await setName(parentUserId, 'Riley Parent');
    await inbound(familyId, parentUserId);
    const created = nowSeconds() - 1200;
    const first = purchase(familyId, { created, subscriptionCreated: created + 10 });
    await startCheckout(familyId, parentUserId, first.created);
    await planRow(familyId, 'plus', first.subscriptionCreated + 5);
    await setPlan(familyId, 'plus');
    return { familyId, parentUserId, first };
  }

  it('holds a second purchase for review, pages once, and leaves the first one true', async () => {
    const { familyId, parentUserId, first } = await familyThatAlreadyPaid();
    const second = purchase(familyId);
    await startCheckout(familyId, parentUserId, second.created);
    expect(await applyEvent(completedEvent(second))).toMatchObject({ status: 'applied' });

    const page = vi.fn().mockResolvedValue('paged');
    expect(await view(second, { page })).toEqual({ state: 'under_review' });
    expect(page).toHaveBeenCalledTimes(1);
    expect(page).toHaveBeenCalledWith(test.database, {
      site: 'checkout_duplicate_payment',
      facts: { transition: 'same_plan' },
      ref: familyId,
    });

    const firstPage = vi.fn().mockResolvedValue('paged');
    expect(await view(first, { page: firstPage })).toMatchObject({
      state: 'plan_active',
    });
    expect(firstPage).not.toHaveBeenCalled();
  });

  it('reaches #ops through the real pager once per family per hour', async () => {
    const post = vi.fn().mockResolvedValue('sent');
    const page: CheckoutViewDeps['page'] = (database, ops) => pageOps(database, ops, { post });

    const one = await familyThatAlreadyPaid();
    const oneDuplicate = purchase(one.familyId);
    await startCheckout(one.familyId, one.parentUserId, oneDuplicate.created);
    await applyEvent(completedEvent(oneDuplicate));
    expect(await view(oneDuplicate, { page })).toEqual({ state: 'under_review' });
    expect(await view(oneDuplicate, { page })).toEqual({ state: 'under_review' });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe(
      `Hale: ops page. site checkout_duplicate_payment. transition same_plan. ref ${one.familyId}.`,
    );

    const two = await familyThatAlreadyPaid();
    const twoDuplicate = purchase(two.familyId);
    await startCheckout(two.familyId, two.parentUserId, twoDuplicate.created);
    await applyEvent(completedEvent(twoDuplicate));
    expect(await view(twoDuplicate, { page })).toEqual({ state: 'under_review' });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[0]).toContain(`ref ${two.familyId}.`);
  });

  it('names a page that did not leave in the server log and keeps the review state', async () => {
    const { familyId, parentUserId } = await familyThatAlreadyPaid();
    const second = purchase(familyId);
    await startCheckout(familyId, parentUserId, second.created);
    await applyEvent(completedEvent(second));

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const page = vi.fn().mockResolvedValue('page_not_configured');
    const result = await view(second, { page });
    const logged = warn.mock.calls.map((call) => [...call]);
    warn.mockRestore();

    expect(result).toEqual({ state: 'under_review' });
    expect(logged).toContainEqual([
      { familyId, transition: 'same_plan', page: 'page_not_configured' },
      'checkout view: a family on a paid plan paid again',
    ]);
  });

  it('names a different plan bought on top as other_plan and never shows it as an upgrade', async () => {
    const { familyId, parentUserId } = await familyThatAlreadyPaid();
    const max = purchase(familyId, { tier: 'family' });
    await startCheckout(familyId, parentUserId, max.created);
    expect(await applyEvent(completedEvent(max))).toMatchObject({ status: 'applied' });

    const page = vi.fn().mockResolvedValue('paged');
    expect(await view(max, { page })).toEqual({ state: 'under_review' });
    expect(page.mock.calls[0]?.[1]).toMatchObject({ facts: { transition: 'other_plan' } });
  });

  it.each([
    ['long before', 3600],
    ['90 seconds before', 90],
    ['30 seconds before', 30],
  ])('reads a family that cancelled %s buying again as a new purchase', async (_name, gap) => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await inbound(familyId, parentUserId);
    const subscriptionCreated = nowSeconds() - 5;
    await planRow(familyId, 'plus', subscriptionCreated - gap - 3600);
    await planRow(familyId, 'free', subscriptionCreated - gap);

    const again = purchase(familyId, { created: subscriptionCreated - 4, subscriptionCreated });
    await startCheckout(familyId, parentUserId, again.created);
    await applyEvent(completedEvent(again));

    const page = vi.fn().mockResolvedValue('paged');
    expect(await view(again, { page })).toMatchObject({ state: 'plan_active' });
    expect(page).not.toHaveBeenCalled();
  });

  it('holds a purchase the price guard refused, without paging a second time', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await inbound(familyId, parentUserId);
    const p = purchase(familyId);
    await startCheckout(familyId, parentUserId, p.created);
    const refused = completedEvent(p);
    (refused.data.object.metadata as { priceId: string }).priceId = 'price_not_sold';
    expect(await applyEvent(refused)).toMatchObject({ status: 'refund_ready' });

    const page = vi.fn().mockResolvedValue('paged');
    expect(await view(p, { page })).toEqual({ state: 'under_review' });
    expect(page).not.toHaveBeenCalled();
  });

  it('does not treat a refusal of another subscription as this purchase', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await inbound(familyId, parentUserId);
    await test.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'billing_refund_ready',
      targetTable: 'families',
      targetId: familyId,
      after: { sessionId: 'cs_test_other', subscriptionId: 'sub_other' },
      occurredAt: new Date((nowSeconds() - 3600) * 1000),
    });
    const p = purchase(familyId);
    await startCheckout(familyId, parentUserId, p.created);
    await applyEvent(completedEvent(p));
    expect(await view(p)).toMatchObject({ state: 'plan_active' });
  });

  it('waits while the webhook has not landed, then settles', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await inbound(familyId, parentUserId);
    const p = purchase(familyId);
    await startCheckout(familyId, parentUserId, p.created);
    expect(await view(p)).toEqual({ state: 'pending' });
    await applyEvent(completedEvent(p));
    expect(await view(p)).toMatchObject({ state: 'plan_active' });
  });

  it('keeps waiting when the webhook commits between its plan read and its grant read', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await inbound(familyId, parentUserId);
    const p = purchase(familyId);
    await startCheckout(familyId, parentUserId, p.created);

    const client = test.client as unknown as { query: (...args: unknown[]) => Promise<unknown> };
    const realQuery = client.query.bind(client);
    let committed = false;
    const spy = vi.spyOn(client, 'query').mockImplementation(async (...args) => {
      const result = await realQuery(...args);
      const text = String(args[0]);
      if (!committed && text.includes('"plan_tier"') && text.includes('from "families"')) {
        committed = true;
        await applyEvent(completedEvent(p));
      }
      return result;
    });
    const raced = await view(p);
    spy.mockRestore();

    expect(committed).toBe(true);
    expect(raced).toEqual({ state: 'pending' });
    expect(await view(p)).toMatchObject({ state: 'plan_active' });
  });

  it('stops waiting when a grant landed and the plan has since dropped to free', async () => {
    const { familyId, p } = await activeFamily();
    const duplicateCancelled = subscriptionEvent(
      { ...p, subscriptionId: uniq('sub_duplicate') },
      'customer.subscription.deleted',
    );
    expect(await applyEvent(duplicateCancelled)).toEqual({ status: 'applied', tier: 'free' });
    expect(
      (
        await test.database
          .select({ planTier: schema.families.planTier })
          .from(schema.families)
          .where(eq(schema.families.id, familyId))
      )[0]?.planTier,
    ).toBe('free');
    expect(await view(p)).toEqual({ state: 'receipt' });
  });

  it('shows the neutral view when the family has moved off the plan this session bought', async () => {
    const { familyId, p } = await activeFamily();
    await setPlan(familyId, 'family');
    expect(await view(p)).toEqual({ state: 'receipt' });
  });

  it('shows the neutral view when the session names no family', async () => {
    const { familyId, p } = await activeFamily();
    const session = {
      ...paidSession(p),
      client_reference_id: null,
      metadata: { tier: 'plus', priceId: 'price_plus' },
    };
    const result = await checkoutViewFromSession(session, 'plus', {
      database: () => test.database,
      env: NO_NOTICES,
      findDirectChat: NO_DIRECT_CHAT,
      page: vi.fn(),
    });
    expect(result).toEqual({ state: 'receipt' });
    expect(familyId).toBeTruthy();
  });

  it('reads nothing about the family on an old link, and shows it inside the window', async () => {
    const { p } = await activeFamily();
    const old = { ...p, created: nowSeconds() - 25 * 3600, expiresAt: nowSeconds() - 3600 };
    const stale = await checkoutViewFromSession(paidSession(old), 'plus', {
      database: untouchable,
      env: NO_NOTICES,
      findDirectChat: NO_DIRECT_CHAT,
      page: vi.fn(),
    });
    expect(stale).toEqual({ state: 'receipt' });

    expect(await view({ ...p, expiresAt: nowSeconds() + 3600 })).toMatchObject({
      state: 'plan_active',
    });
  });

  it('promises the check-in only in the half hour after paying', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await setName(parentUserId, 'Riley Parent');
    const now = nowSeconds();
    const chat = uniq('chat_direct');
    await inbound(familyId, parentUserId, {
      providerChatId: chat,
      createdAt: new Date((now - 7000) * 1000),
    });
    await verifiedChannel(familyId, parentUserId);
    const p = purchase(familyId, { created: now - 3700, subscriptionCreated: now - 3600 });
    await startCheckout(familyId, parentUserId, p.created);
    await applyEvent(completedEvent(p));
    const env = {
      BILLING_THREAD_NOTICES_ENABLED: 'true',
      BILLING_THREAD_NOTICES_SINCE: new Date((now - 7200) * 1000).toISOString(),
    };
    const findDirectChat = async () => chat;

    expect(await view(p, { env, findDirectChat })).toEqual({
      state: 'plan_active',
      checkInDue: false,
    });
    expect(await view({ ...p, subscriptionCreated: now - 60 }, { env, findDirectChat })).toEqual({
      state: 'plan_active',
      checkInDue: true,
    });
  });

  it('answers open and expired sessions from Stripe alone', async () => {
    for (const status of ['open', 'expired']) {
      const result = await checkoutViewFromSession(
        paidSession({
          familyId: '11111111-1111-4111-8111-111111111111',
          sessionId: 'cs_test_unfinished',
          subscriptionId: 'sub_unfinished',
          created: nowSeconds() - 60,
          subscriptionCreated: nowSeconds() - 50,
          status,
          paymentStatus: 'unpaid',
        }),
        'plus',
        { database: untouchable, env: NO_NOTICES, findDirectChat: NO_DIRECT_CHAT, page: vi.fn() },
      );
      expect(result).toEqual({ state: 'not_paid' });
    }
  });

  it('keeps a paid session waiting when the family read fails', async () => {
    const result = await checkoutViewFromSession(
      paidSession({
        familyId: '11111111-1111-4111-8111-111111111111',
        sessionId: 'cs_test_dbfail',
        subscriptionId: 'sub_dbfail',
        created: nowSeconds() - 60,
        subscriptionCreated: nowSeconds() - 50,
      }),
      'plus',
      { database: untouchable, env: NO_NOTICES, findDirectChat: NO_DIRECT_CHAT, page: vi.fn() },
    );
    expect(result).toEqual({ state: 'pending' });
  });
});

describe('who paid', () => {
  it('uses the payer own thread: a co-parent with a verified channel and no 1:1 text is a new visitor', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await inbound(familyId, parentUserId);
    const coparent = await coParent(familyId);
    await verifiedChannel(familyId, coparent);
    await inbound(familyId, coparent, { inGroup: true, providerChatId: 'chat_family_group' });
    await test.database
      .update(schema.families)
      .set({ linqGroupChatId: 'chat_family_group' })
      .where(eq(schema.families.id, familyId));

    const p = purchase(familyId);
    await startCheckout(familyId, coparent, p.created);
    await applyEvent(completedEvent(p));
    expect(await view(p)).toEqual({ state: 'new_visitor' });

    await inbound(familyId, coparent);
    expect(await view(p)).toMatchObject({ state: 'plan_active' });
  });

  it('counts an inbound SMS outside the group as a 1:1 thread, and a group one as none', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    expect(await hasOneToOneThread(test.database, parentUserId, 'chat_group')).toBe(false);
    await inbound(familyId, parentUserId, {
      channel: 'sms',
      providerChatId: 'chat_group',
      inGroup: true,
    });
    expect(await hasOneToOneThread(test.database, parentUserId, 'chat_group')).toBe(false);
    await inbound(familyId, parentUserId, { channel: 'sms', providerChatId: null, inGroup: null });
    expect(await hasOneToOneThread(test.database, parentUserId, 'chat_group')).toBe(true);
  });

  it('counts a 1:1 text from before the group bit existed as a thread', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await setName(parentUserId, 'Riley Parent');
    await inbound(familyId, parentUserId, { inGroup: null, providerChatId: 'chat_old_direct' });
    await test.database
      .update(schema.families)
      .set({ linqGroupChatId: uniq('chat_family_group') })
      .where(eq(schema.families.id, familyId));
    const p = purchase(familyId);
    await startCheckout(familyId, parentUserId, p.created);
    await applyEvent(completedEvent(p));
    expect(await view(p)).toEqual({ state: 'plan_active', checkInDue: false });
  });

  it('a row with no group bit inside the family group is not a thread', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await inbound(familyId, parentUserId, { inGroup: null, providerChatId: 'chat_family_group' });
    expect(await hasOneToOneThread(test.database, parentUserId, 'chat_family_group')).toBe(false);
    expect(await hasOneToOneThread(test.database, parentUserId, 'chat_other')).toBe(true);
  });

  it('a row marked as a group is not a thread in any chat', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await inbound(familyId, parentUserId, { inGroup: true, providerChatId: 'chat_some_group' });
    expect(await hasOneToOneThread(test.database, parentUserId, null)).toBe(false);
  });

  it('binds the payer to this session when another parent opens checkout later', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await setName(parentUserId, 'Avery Parent');
    await inbound(familyId, parentUserId);
    const other = await coParent(familyId);
    const p = purchase(familyId);
    await startCheckout(familyId, parentUserId, p.created);
    await startCheckout(familyId, other, p.created + 3600);
    await applyEvent(completedEvent(p));
    expect(await resolveCheckoutPayer(test.database, familyId, p.created)).toBe(parentUserId);
    expect(await view(p)).toMatchObject({ state: 'plan_active' });
  });

  it('names nobody when two parents started checkout inside this session window', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await inbound(familyId, parentUserId);
    const other = await coParent(familyId);
    await inbound(familyId, other);
    const p = purchase(familyId);
    await startCheckout(familyId, parentUserId, p.created);
    await startCheckout(familyId, other, p.created + 5);
    await applyEvent(completedEvent(p));
    expect(await resolveCheckoutPayer(test.database, familyId, p.created)).toBeNull();
    expect(await view(p)).toEqual({ state: 'new_visitor' });
  });

  it('names nobody when the actor has left the family', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await inbound(familyId, parentUserId);
    const gone = await coParent(familyId);
    await inbound(familyId, gone);
    await test.database.delete(schema.familyMembers).where(eq(schema.familyMembers.userId, gone));
    const p = purchase(familyId);
    await startCheckout(familyId, gone, p.created);
    await applyEvent(completedEvent(p));
    expect(await resolveCheckoutPayer(test.database, familyId, p.created)).toBeNull();
    expect(await view(p)).toEqual({ state: 'new_visitor' });
  });

  it('names nobody when the actor is not a person', async () => {
    const { familyId } = await seedFamily(test.database);
    const p = purchase(familyId);
    await startCheckout(familyId, 'system', p.created);
    expect(await resolveCheckoutPayer(test.database, familyId, p.created)).toBeNull();
  });

  it('carries no check-in on any state but the active plan', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await setName(parentUserId, 'Named Parent');
    const p = purchase(familyId);
    await startCheckout(familyId, parentUserId, p.created);
    await applyEvent(completedEvent(p));
    const result = await view(p);
    expect(result).toEqual({ state: 'new_visitor' });
    expect(JSON.stringify(result)).not.toContain('Named');
  });
});

describe('the check-in sentence', () => {
  const armed = (since: string): Record<string, string> => ({
    BILLING_THREAD_NOTICES_ENABLED: 'true',
    BILLING_THREAD_NOTICES_SINCE: since,
  });

  /** A payer the notices lane would text: an inbound row in Linq's direct chat, before the session. */
  async function checkInFamily(rowOver: Partial<typeof schema.channelMessages.$inferInsert> = {}) {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await setName(parentUserId, 'Riley Parent');
    const channelId = await verifiedChannel(familyId, parentUserId);
    const p = purchase(familyId);
    const chat = uniq('chat_direct');
    await inbound(familyId, parentUserId, {
      providerChatId: chat,
      createdAt: new Date((p.created - 3600) * 1000),
      ...rowOver,
    });
    await startCheckout(familyId, parentUserId, p.created);
    expect(await applyEvent(completedEvent(p))).toMatchObject({ status: 'applied' });
    const sinceBefore = new Date((p.subscriptionCreated - 3600) * 1000).toISOString();
    const findDirectChat = vi.fn(async (_phone: string): Promise<string | null> => chat);
    return { familyId, parentUserId, p, channelId, sinceBefore, chat, findDirectChat };
  }

  it('is due on the lane proof, and asks about the parent current number', async () => {
    const { p, sinceBefore, findDirectChat } = await checkInFamily();
    expect(await view(p, { env: armed(sinceBefore), findDirectChat })).toEqual({
      state: 'plan_active',
      checkInDue: true,
    });
    expect(findDirectChat).toHaveBeenCalledWith(PARENT_PHONE);
  });

  it('is due for a parent whose only 1:1 text predates the group bit', async () => {
    const { p, sinceBefore, findDirectChat } = await checkInFamily({ inGroup: null });
    expect(await view(p, { env: armed(sinceBefore), findDirectChat })).toMatchObject({
      state: 'plan_active',
      checkInDue: true,
    });
  });

  it('is not due with the flag unset or not exactly true, and asks Linq nothing', async () => {
    const { p, sinceBefore, findDirectChat } = await checkInFamily();
    for (const value of [undefined, 'TRUE', 'true\n']) {
      const env = {
        BILLING_THREAD_NOTICES_ENABLED: value,
        BILLING_THREAD_NOTICES_SINCE: sinceBefore,
      };
      expect(await view(p, { env, findDirectChat })).toMatchObject({
        state: 'plan_active',
        checkInDue: false,
      });
    }
    expect(findDirectChat).not.toHaveBeenCalled();
  });

  it('is not due with a SINCE the lane refuses', async () => {
    const { p, sinceBefore, findDirectChat } = await checkInFamily();
    for (const since of [
      '',
      'yesterday',
      '2026-11-21',
      `${sinceBefore}\n`,
      '2026-02-30T00:00:00Z',
      sinceBefore.replace(/\.\d{3}Z$/, '.5Z'),
    ]) {
      expect(await view(p, { env: armed(since), findDirectChat })).toMatchObject({
        state: 'plan_active',
        checkInDue: false,
      });
    }
    expect(findDirectChat).not.toHaveBeenCalled();
  });

  it('is not due for a subscription older than SINCE', async () => {
    const { p, findDirectChat } = await checkInFamily();
    const after = new Date((p.subscriptionCreated + 3600) * 1000).toISOString();
    expect(await view(p, { env: armed(after), findDirectChat })).toMatchObject({
      state: 'plan_active',
      checkInDue: false,
    });
  });

  it('is not due when the payer channel is revoked', async () => {
    const { p, channelId, sinceBefore, findDirectChat } = await checkInFamily();
    await test.database
      .update(schema.parentChannels)
      .set({ revokedAt: new Date() })
      .where(eq(schema.parentChannels.id, channelId));
    expect(await view(p, { env: armed(sinceBefore), findDirectChat })).toMatchObject({
      state: 'plan_active',
      checkInDue: false,
    });
  });

  it('is not due for a new visitor who texts only after paying', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await setName(parentUserId, 'Riley Parent');
    await verifiedChannel(familyId, parentUserId);
    const p = purchase(familyId);
    await startCheckout(familyId, parentUserId, p.created);
    await applyEvent(completedEvent(p));
    const chat = uniq('chat_direct');
    const after = new Date((p.created + 5) * 1000);
    await inbound(familyId, parentUserId, {
      providerChatId: chat,
      createdAt: after,
      sentAt: after,
    });
    const sinceBefore = new Date((p.subscriptionCreated - 3600) * 1000).toISOString();
    expect(
      await view(p, { env: armed(sinceBefore), findDirectChat: async () => chat }),
    ).toMatchObject({ state: 'plan_active', checkInDue: false });
  });

  it('is not due when the only inbound text is an old SMS with no Linq chat', async () => {
    const { p, sinceBefore } = await checkInFamily({ channel: 'sms', providerChatId: null });
    expect(
      await view(p, { env: armed(sinceBefore), findDirectChat: NO_DIRECT_CHAT }),
    ).toMatchObject({ state: 'plan_active', checkInDue: false });
  });

  it('is not due when the text is in a chat other than Linq direct one', async () => {
    const { p, sinceBefore } = await checkInFamily();
    expect(
      await view(p, { env: armed(sinceBefore), findDirectChat: async () => 'chat_another' }),
    ).toMatchObject({ state: 'plan_active', checkInDue: false });
  });

  it('leaves the sentence out and keeps the plan when Linq cannot answer', async () => {
    const { p, sinceBefore } = await checkInFamily();
    const findDirectChat = async () => {
      throw new LinqSendError('timeout', 0, false);
    };
    expect(await view(p, { env: armed(sinceBefore), findDirectChat })).toEqual({
      state: 'plan_active',
      checkInDue: false,
    });
  });

  it('leaves the sentence out and keeps the plan when the proof throws anything else', async () => {
    const { p, sinceBefore } = await checkInFamily();
    const findDirectChat = async () => {
      throw new TypeError('bug');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await view(p, { env: armed(sinceBefore), findDirectChat })).toEqual({
      state: 'plan_active',
      checkInDue: false,
    });
    expect(warn).toHaveBeenCalledWith('checkout view: thread proof failed', { err: 'TypeError' });
    warn.mockRestore();
  });
});

describe('the /join already-paid screen', () => {
  const ON = { CHECKOUT_SUCCESS_STATES_ENABLED: 'true' };

  it('counts the same threads as the success page, only with the flag on', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await inbound(familyId, parentUserId, { inGroup: null, providerChatId: 'chat_old_direct' });
    expect(await alreadyPaidParentHasThread(test.database, familyId, parentUserId, ON)).toBe(true);
    for (const value of [undefined, 'TRUE', 'true\n']) {
      expect(
        await alreadyPaidParentHasThread(untouchable(), familyId, parentUserId, {
          CHECKOUT_SUCCESS_STATES_ENABLED: value,
        }),
      ).toBe(false);
    }
  });

  it('is false for a parent who has only written in the family group', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    const groupChat = uniq('chat_family_group');
    await test.database
      .update(schema.families)
      .set({ linqGroupChatId: groupChat })
      .where(eq(schema.families.id, familyId));
    await inbound(familyId, parentUserId, { inGroup: null, providerChatId: groupChat });
    expect(await alreadyPaidParentHasThread(test.database, familyId, parentUserId, ON)).toBe(false);
    await inbound(familyId, parentUserId, { inGroup: false, providerChatId: uniq('chat_direct') });
    expect(await alreadyPaidParentHasThread(test.database, familyId, parentUserId, ON)).toBe(true);
  });

  it('answers null, not false, and names the failure when the read fails', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await alreadyPaidParentHasThread(untouchable(), familyId, parentUserId, ON)).toBeNull();
    expect(warn).toHaveBeenCalledWith('founding paid screen: thread read failed', {
      err: 'Error',
    });
    warn.mockRestore();
  });
});
