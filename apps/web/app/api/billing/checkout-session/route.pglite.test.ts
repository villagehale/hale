import { type Database, schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptString } from '~/lib/crypto/string-cipher';
import { setRateLimiterForTesting } from '~/lib/rate-limit/apply';
import { createFakeStripe } from '~/lib/testing/fake-stripe';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

const findDirectChatMock = vi.fn();
const authMock = vi.fn();
let test: TestDb;

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => test.database }));
vi.mock('~/lib/channel/outbound-transport', () => ({
  findHaleDirectChat: (...args: unknown[]) => findDirectChatMock(...args),
}));

const PARENT_NAME = 'Riley Parent';
const PARENT_PHONE = '+14165550101';
const CHAT_ID = 'chat_direct_payer';
const SESSION_ID = 'cs_test_no_personal_data';
const URL_WITH_ID = `https://app.example.com/api/billing/checkout-session?session_id=${SESSION_ID}`;
/** The Stripe facts the flag-off route already returns: all any holder of the id may read. */
const PUBLIC_KEYS = ['currency', 'paid', 'tier', 'transactionId', 'value'];

let stripe: ReturnType<typeof createFakeStripe>;

beforeAll(async () => {
  test = await createTestDb();
});

afterAll(async () => {
  await test.close();
});

beforeEach(() => {
  stripe = createFakeStripe();
  vi.stubGlobal('fetch', stripe.fetch);
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('CHECKOUT_SUCCESS_STATES_ENABLED', 'true');
  vi.stubEnv('BILLING_THREAD_NOTICES_ENABLED', 'true');
  vi.stubEnv(
    'BILLING_THREAD_NOTICES_SINCE',
    new Date(Date.now() - 2 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
  );
  authMock.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  setRateLimiterForTesting(undefined);
  findDirectChatMock.mockReset();
  authMock.mockReset();
});

async function signedInAs(database: Database, userId: string): Promise<void> {
  const externalAuthId = `auth-${userId}`;
  await database.update(schema.users).set({ externalAuthId }).where(eq(schema.users.id, userId));
  authMock.mockResolvedValue({ user: { id: externalAuthId } });
}

/** A family that just bought Plus and already texts Hale: on main this is `plan_active`. */
async function seedPaidFamily() {
  const { familyId, parentUserId } = await seedFamily(test.database);
  const email = `payer-${familyId}@example.test`;
  await test.database
    .update(schema.users)
    .set({ name: PARENT_NAME, email })
    .where(eq(schema.users.id, parentUserId));
  await test.database
    .update(schema.families)
    .set({ planTier: 'plus' })
    .where(eq(schema.families.id, familyId));
  await test.database.insert(schema.parentChannels).values({
    userId: parentUserId,
    familyId,
    phoneE164Encrypted: encryptString(PARENT_PHONE),
    phoneE164Hash: `hash_${familyId}`,
    verifiedAt: new Date(),
  });
  const nowSeconds = Math.floor(Date.now() / 1000);
  const created = nowSeconds - 120;
  await test.database.insert(schema.channelMessages).values({
    familyId,
    parentUserId,
    channel: 'imessage',
    direction: 'in',
    category: 'reply',
    status: 'delivered',
    providerChatId: CHAT_ID,
    inGroup: false,
    createdAt: new Date((created - 3600) * 1000),
  });
  await test.database.insert(schema.auditLog).values([
    {
      familyId,
      actor: parentUserId,
      actionTaken: 'billing_checkout_started',
      targetTable: 'families',
      targetId: familyId,
      after: { tier: 'plus' },
      occurredAt: new Date((created + 2) * 1000),
    },
    {
      familyId,
      actor: 'system',
      actionTaken: 'family_plan_updated',
      targetTable: 'families',
      targetId: familyId,
      after: { planTier: 'plus', source: 'stripe', stripeEventId: 'evt_no_personal_data' },
      occurredAt: new Date((created + 20) * 1000),
    },
  ]);
  findDirectChatMock.mockResolvedValue(CHAT_ID);
  stripe.intercept(
    (call) => call.method === 'GET' && call.path === `/v1/checkout/sessions/${SESSION_ID}`,
    () =>
      Response.json({
        id: SESSION_ID,
        object: 'checkout.session',
        status: 'complete',
        payment_status: 'paid',
        amount_total: 5900,
        currency: 'cad',
        created,
        expires_at: created + 24 * 3600,
        client_reference_id: familyId,
        customer: 'cus_no_personal_data',
        customer_details: { email, phone: PARENT_PHONE, name: PARENT_NAME },
        metadata: { familyId, tier: 'plus', priceId: 'price_plus' },
        subscription: { id: 'sub_no_personal_data', created: created + 10, status: 'active' },
      }),
  );
  return { familyId, parentUserId, email };
}

async function get(): Promise<{ text: string; body: Record<string, unknown> }> {
  const { GET } = await import('./route');
  const res = await GET(new Request(URL_WITH_ID));
  expect(res.status).toBe(200);
  const text = await res.text();
  return { text, body: JSON.parse(text) };
}

function expectNothingPersonal(
  text: string,
  family: { familyId: string; parentUserId: string; email: string },
): void {
  for (const personal of [
    'Riley',
    family.email,
    PARENT_PHONE,
    family.familyId,
    family.parentUserId,
    CHAT_ID,
    'cus_no_personal_data',
    'firstName',
  ]) {
    expect(text).not.toContain(personal);
  }
}

describe('GET /api/billing/checkout-session on real family rows', () => {
  it('tells a holder of the session id alone only the Stripe facts, with no Linq read', async () => {
    const paying = await seedPaidFamily();

    const { text, body } = await get();

    expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS);
    expect(body).toEqual({
      transactionId: SESSION_ID,
      value: 59,
      currency: 'CAD',
      paid: true,
      tier: 'plus',
    });
    expect(findDirectChatMock).not.toHaveBeenCalled();
    expectNothingPersonal(text, paying);
    expect(stripe.calls.map((call) => call.path)).toEqual([`/v1/checkout/sessions/${SESSION_ID}`]);
  });

  it('gives a signed-in parent of the paying family the page state, and nothing personal', async () => {
    const paying = await seedPaidFamily();
    await signedInAs(test.database, paying.parentUserId);

    const { text, body } = await get();

    expect(body).toEqual({
      transactionId: SESSION_ID,
      value: 59,
      currency: 'CAD',
      paid: true,
      tier: 'plus',
      view: { state: 'plan_active', checkInDue: true },
    });
    expect(findDirectChatMock).toHaveBeenCalledWith(PARENT_PHONE);
    expectNothingPersonal(text, paying);
  });

  it('gives a signed-in parent of another family only the Stripe facts', async () => {
    const paying = await seedPaidFamily();
    const other = await seedFamily(test.database, 'Other Family');
    await signedInAs(test.database, other.parentUserId);

    const { text, body } = await get();

    expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS);
    expect(findDirectChatMock).not.toHaveBeenCalled();
    expectNothingPersonal(text, paying);
  });

  it('gives a caregiver seated in the paying family only the Stripe facts', async () => {
    const { familyId } = await seedPaidFamily();
    const [nanny] = await test.database
      .insert(schema.users)
      .values({ email: `nanny-${familyId}@example.test`, name: 'Test Nanny' })
      .returning({ id: schema.users.id });
    if (!nanny) throw new Error('nanny insert returned no row');
    await test.database
      .insert(schema.familyMembers)
      .values({ familyId, userId: nanny.id, role: 'nanny' });
    await signedInAs(test.database, nanny.id);

    const { body } = await get();

    expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS);
    expect(findDirectChatMock).not.toHaveBeenCalled();
  });

  it('gives the paying parent only the Stripe facts once this session is over its limit', async () => {
    const paying = await seedPaidFamily();
    await signedInAs(test.database, paying.parentUserId);
    const checks: Array<[string, string]> = [];
    setRateLimiterForTesting({
      async check(key, route) {
        checks.push([key, route]);
        return { allowed: false, retryAfterSec: 60, firstDenied: true };
      },
    });

    const { body } = await get();

    expect(checks).toEqual([[SESSION_ID, 'checkout-session-view']]);
    expect(Object.keys(body).sort()).toEqual(PUBLIC_KEYS);
    expect(findDirectChatMock).not.toHaveBeenCalled();
  });
});
