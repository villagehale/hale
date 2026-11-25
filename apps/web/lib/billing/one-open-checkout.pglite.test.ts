import { schema } from '@hale/db';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeOtpSender } from '~/lib/channels/otp-sender';
import { pageOps } from '~/lib/monitoring/failure-page';
import { type FakeStripe, createFakeStripe, stripeError } from '~/lib/testing/fake-stripe';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { createBillingCheckout } from './create-checkout';
import { requestPromoJoinCode, verifyPromoJoinCode } from './new-visitor-join';
import { type StripeCheckoutClient, stripeCheckoutClientFromEnv } from './stripe-client';

// ~/lib/family imports the Auth.js session reader; nothing here signs anyone in.
vi.mock('~/auth', () => ({ auth: async () => null }));

/**
 * VIL-729 · at most one payable Checkout Session per family. Real checkout functions, real
 * Postgres (pglite, every migration), the real Stripe client over the in-memory Stripe, and
 * the real #ops pager with only its Slack post captured.
 */

const ENV_ON: Record<string, string | undefined> = { ONE_OPEN_CHECKOUT_ENABLED: 'true' };
const ENV_OFF: Record<string, string | undefined> = {};
const PLUS = 'price_plus_annual_test';
const MAX = 'price_max_annual_test';
const ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
const JOIN_PHONE = '+14165550142';
const JOIN_CODE = '731904';

let test: TestDb;
let fake: FakeStripe;
let client: StripeCheckoutClient;
let post: ReturnType<typeof vi.fn>;
let nextAuth = 0;

beforeAll(async () => {
  test = await createTestDb();
});

afterAll(async () => {
  await test.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', ENCRYPTION_KEY);
  fake = createFakeStripe();
  const built = stripeCheckoutClientFromEnv({ STRIPE_SECRET_KEY: 'sk_test_fake' }, fake.fetch);
  if (!built) throw new Error('expected a configured Stripe client');
  client = built;
  post = vi.fn().mockResolvedValue('sent');
});

interface Parent {
  familyId: string;
  userId: string;
  externalAuthId: string;
}

async function signedInParent(planTier: 'free' | 'plus' = 'free'): Promise<Parent> {
  const seeded = await seedFamily(test.database);
  nextAuth += 1;
  const externalAuthId = `google-sub-${nextAuth}`;
  await test.database
    .update(schema.users)
    .set({ externalAuthId })
    .where(eq(schema.users.id, seeded.parentUserId));
  if (planTier !== 'free') {
    await test.database
      .update(schema.families)
      .set({ planTier })
      .where(eq(schema.families.id, seeded.familyId));
  }
  return { familyId: seeded.familyId, userId: seeded.parentUserId, externalAuthId };
}

async function secondParent(familyId: string): Promise<Parent> {
  nextAuth += 1;
  const externalAuthId = `google-sub-${nextAuth}`;
  const [user] = await test.database
    .insert(schema.users)
    .values({ externalAuthId, email: null, name: null })
    .returning({ id: schema.users.id });
  if (!user) throw new Error('no users row');
  await test.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: user.id, role: 'co_parent' });
  return { familyId, userId: user.id, externalAuthId };
}

function checkout(
  parent: Parent,
  priceId: string,
  env: Record<string, string | undefined> = ENV_ON,
  extra: Partial<Parameters<typeof createBillingCheckout>[0]> = {},
) {
  return createBillingCheckout({
    tier: priceId === MAX ? 'family' : 'plus',
    period: 'annual',
    priceId,
    externalAuthId: parent.externalAuthId,
    customerEmail: null,
    database: test.database,
    client,
    origin: 'https://app.example.test',
    marketingOrigin: 'https://www.example.test',
    env,
    page: (database, ops) => pageOps(database, ops, { post }),
    ...extra,
  });
}

function creates(): number {
  return fake.calls.filter((c) => c.method === 'POST' && c.path === '/v1/checkout/sessions').length;
}

async function auditVerbs(familyId: string, verb: string): Promise<number> {
  const rows = await test.database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(and(eq(schema.auditLog.familyId, familyId), eq(schema.auditLog.actionTaken, verb)));
  return rows.length;
}

/** The sessions this path recorded on its audit rows, oldest first, with who opened each. */
async function recordedSessions(familyId: string) {
  const rows = await test.database
    .select({ actor: schema.auditLog.actor, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'billing_checkout_started'),
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt));
  return rows
    .map((r) => ({ sessionId: (r.after as { sessionId?: string }).sessionId, actor: r.actor }))
    .filter((r) => r.sessionId !== undefined);
}

describe('ONE_OPEN_CHECKOUT_ENABLED on', () => {
  it('two requests at the same moment for the same price leave one payable session', async () => {
    const parent = await signedInParent();

    const [first, second] = await Promise.all([checkout(parent, PLUS), checkout(parent, PLUS)]);

    expect(first.status).toBe('created');
    expect(second.status).toBe('created');
    const payable = fake.payableCheckoutSessions(parent.familyId);
    expect(payable).toHaveLength(1);
    expect(creates()).toBe(1);
    const url = payable[0]?.url;
    expect(first).toEqual({ status: 'created', url });
    expect(second).toEqual({ status: 'created', url });
    const create = fake.calls.find((c) => c.path === '/v1/checkout/sessions');
    expect(create?.headers.get('idempotency-key')).toMatch(/^[0-9a-f]{64}$/);
    const opened = { sessionId: payable[0]?.id, actor: parent.userId };
    expect(await recordedSessions(parent.familyId)).toEqual([opened, opened]);
  });

  it('decides under a row lock on the family, which is what makes Postgres take turns', async () => {
    // pglite runs one transaction at a time on its own, so the Promise.all above passes
    // with or without the lock. Real Postgres does not: the lock is the guarantee, so the
    // statement itself is observed, at the driver, inside the transaction.
    const parent = await signedInParent();
    const statements: string[] = [];
    const original = test.client.transaction.bind(test.client);
    const spy = vi.spyOn(test.client, 'transaction').mockImplementation((callback) =>
      original((tx) => {
        const query = tx.query.bind(tx);
        return callback(
          Object.assign(Object.create(tx), {
            query: (text: string, ...rest: unknown[]) => {
              statements.push(text);
              return (query as (...args: unknown[]) => unknown)(text, ...rest);
            },
          }),
        );
      }),
    );
    try {
      expect((await checkout(parent, PLUS)).status).toBe('created');
    } finally {
      spy.mockRestore();
    }

    const lockedRead = statements.findIndex((s) => /from "families".* for update$/is.test(s));
    expect(lockedRead).toBeGreaterThan(-1);
    const write = statements.findIndex((s) => /^insert into "audit_log"/i.test(s));
    expect(write).toBeGreaterThan(lockedRead);
  });

  it('a request for another price expires the open session before it creates the new one', async () => {
    const parent = await signedInParent();
    const plus = await checkout(parent, PLUS);
    expect(plus.status).toBe('created');
    const [plusSession] = fake.payableCheckoutSessions(parent.familyId);
    if (!plusSession) throw new Error('expected the Plus session');

    const max = await checkout(parent, MAX);

    expect(max.status).toBe('created');
    expect(fake.checkoutSessions.get(plusSession.id)?.status).toBe('expired');
    const payable = fake.payableCheckoutSessions(parent.familyId);
    expect(payable.map((s) => s.metadata.priceId)).toEqual([MAX]);
    expect(max).toEqual({ status: 'created', url: payable[0]?.url });
    const expireAt = fake.calls.findIndex(
      (c) => c.method === 'POST' && c.path === `/v1/checkout/sessions/${plusSession.id}/expire`,
    );
    const secondCreateAt = fake.calls.findLastIndex(
      (c) => c.method === 'POST' && c.path === '/v1/checkout/sessions',
    );
    expect(expireAt).toBeGreaterThan(-1);
    expect(expireAt).toBeLessThan(secondCreateAt);
    expect(() => fake.completeCheckout(plusSession.id, 'sub_plus')).toThrow(/is not open/);
    expect(await auditVerbs(parent.familyId, 'billing_checkout_expired')).toBe(1);
    expect(await auditVerbs(parent.familyId, 'billing_checkout_started')).toBe(2);
  });

  it("a co-parent's request for the same price gets its own session, so the payer is theirs", async () => {
    const parent = await signedInParent();
    const coParent = await secondParent(parent.familyId);
    const mine = await checkout(parent, PLUS);
    const [mineSession] = fake.payableCheckoutSessions(parent.familyId);

    const theirs = await checkout(coParent, PLUS);

    expect(mine.status).toBe('created');
    expect(theirs.status).toBe('created');
    expect(fake.checkoutSessions.get(mineSession?.id ?? '')?.status).toBe('expired');
    const payable = fake.payableCheckoutSessions(parent.familyId);
    expect(payable).toHaveLength(1);
    expect(theirs).toEqual({ status: 'created', url: payable[0]?.url });
  });

  it('a session paid before its webhook landed refuses a second checkout until that plan ends', async () => {
    const parent = await signedInParent();
    await checkout(parent, PLUS);
    const [paid] = fake.payableCheckoutSessions(parent.familyId);
    if (!paid) throw new Error('expected the Plus session');
    fake.completeCheckout(paid.id, 'sub_paid_before_webhook');

    expect(await checkout(parent, MAX)).toEqual({ status: 'already_paid' });
    expect(creates()).toBe(1);

    const subscription = fake.subscriptions.get('sub_paid_before_webhook');
    if (!subscription) throw new Error('expected the subscription');
    subscription.status = 'canceled';
    const again = await checkout(parent, MAX);
    expect(again.status).toBe('created');
    expect(creates()).toBe(2);
  });

  it('a checkout started while the flag was off does not hide the session opened with it on', async () => {
    const parent = await signedInParent();
    await checkout(parent, PLUS);
    const [plusSession] = fake.payableCheckoutSessions(parent.familyId);
    await checkout(parent, PLUS, ENV_OFF);

    const max = await checkout(parent, MAX);

    expect(max.status).toBe('created');
    expect(fake.checkoutSessions.get(plusSession?.id ?? '')?.status).toBe('expired');
  });

  it('a family already on a paid plan is refused as on main, and Stripe is never called', async () => {
    const parent = await signedInParent('plus');

    expect(await checkout(parent, PLUS)).toEqual({ status: 'already_paid' });
    expect(await checkout(parent, MAX)).toEqual({ status: 'already_paid' });
    expect(fake.calls).toHaveLength(0);
  });

  it('the new-visitor promo join holds the same rule for its pending family', async () => {
    const sender = new FakeOtpSender();
    expect(
      await requestPromoJoinCode(
        test.database,
        { phoneRaw: JOIN_PHONE },
        { sender, generateCode: () => JOIN_CODE },
      ),
    ).toEqual({ status: 'sent' });
    const verified = await verifyPromoJoinCode(test.database, {
      phoneRaw: JOIN_PHONE,
      code: JOIN_CODE,
    });
    if (verified.status !== 'ok') throw new Error(`join refused: ${verified.reason}`);
    const joiner: Parent = {
      familyId: verified.familyId,
      userId: verified.userId,
      externalAuthId: verified.externalAuthId,
    };
    const join = { familyId: joiner.familyId, cancelUrl: 'https://app.example.test/founding' };

    const [first, second] = await Promise.all([
      checkout(joiner, PLUS, ENV_ON, join),
      checkout(joiner, PLUS, ENV_ON, join),
    ]);
    expect(first).toEqual(second);
    expect(fake.payableCheckoutSessions(joiner.familyId)).toHaveLength(1);

    const max = await checkout(joiner, MAX, ENV_ON, join);
    const payable = fake.payableCheckoutSessions(joiner.familyId);
    expect(payable.map((s) => s.metadata.priceId)).toEqual([MAX]);
    expect(max).toEqual({ status: 'created', url: payable[0]?.url });
  });

  it('an expire Stripe refuses leaves the first session the only one, and pages #ops', async () => {
    const parent = await signedInParent();
    await checkout(parent, PLUS);
    fake.intercept(
      (c) => c.method === 'POST' && c.path.endsWith('/expire'),
      () => stripeError(500),
    );

    await expect(checkout(parent, MAX)).rejects.toThrow(/open checkout session was not expired/);

    const payable = fake.payableCheckoutSessions(parent.familyId);
    expect(payable.map((s) => s.metadata.priceId)).toEqual([PLUS]);
    expect(creates()).toBe(1);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]?.[0]).toBe(
      `Hale: ops page. site checkout_session_unexpired. ref ${parent.familyId}.`,
    );
    expect(await auditVerbs(parent.familyId, 'billing_checkout_expired')).toBe(0);
  });
});

describe('ONE_OPEN_CHECKOUT_ENABLED off', () => {
  it('is main: two requests make two payable sessions, with no Idempotency-Key', async () => {
    const parent = await signedInParent();

    await Promise.all([checkout(parent, PLUS, ENV_OFF), checkout(parent, MAX, ENV_OFF)]);

    expect(fake.payableCheckoutSessions(parent.familyId)).toHaveLength(2);
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/checkout/sessions',
      'POST /v1/checkout/sessions',
    ]);
    expect(fake.calls.every((c) => c.headers.get('idempotency-key') === null)).toBe(true);
    expect(await recordedSessions(parent.familyId)).toEqual([]);
    expect(await auditVerbs(parent.familyId, 'billing_checkout_started')).toBe(2);
  });
});
