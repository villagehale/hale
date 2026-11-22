import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptString } from '~/lib/crypto/string-cipher';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';

const retrieveMock = vi.fn();
const findDirectChatMock = vi.fn();
let test: TestDb;

vi.mock('~/lib/billing/stripe-client', () => ({
  stripeCheckoutClientFromEnv: () => ({
    createCheckoutSession: vi.fn(),
    retrieveCheckoutSession: (...args: unknown[]) => retrieveMock(...args),
  }),
}));
vi.mock('~/lib/db', () => ({ db: () => test.database }));
vi.mock('~/lib/channel/outbound-transport', () => ({
  findHaleDirectChat: (...args: unknown[]) => findDirectChatMock(...args),
}));

const PARENT_NAME = 'Riley Parent';
const PARENT_EMAIL = 'payer@example.test';
const PARENT_PHONE = '+14165550101';
const CHAT_ID = 'chat_direct_payer';
const SESSION_ID = 'cs_test_no_personal_data';
const URL_WITH_ID = `https://app.example.com/api/billing/checkout-session?session_id=${SESSION_ID}`;

beforeAll(async () => {
  test = await createTestDb();
});

afterAll(async () => {
  await test.close();
});

beforeEach(() => {
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('CHECKOUT_SUCCESS_STATES_ENABLED', 'true');
  vi.stubEnv('BILLING_THREAD_NOTICES_ENABLED', 'true');
  vi.stubEnv(
    'BILLING_THREAD_NOTICES_SINCE',
    new Date(Date.now() - 2 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '.000Z'),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  retrieveMock.mockReset();
  findDirectChatMock.mockReset();
});

describe('GET /api/billing/checkout-session on real family rows', () => {
  it('unlocks the plan state and nothing personal from the session id alone', async () => {
    const { familyId, parentUserId } = await seedFamily(test.database);
    await test.database
      .update(schema.users)
      .set({ name: PARENT_NAME, email: PARENT_EMAIL })
      .where(eq(schema.users.id, parentUserId));
    await test.database
      .update(schema.families)
      .set({ planTier: 'plus' })
      .where(eq(schema.families.id, familyId));
    await test.database.insert(schema.parentChannels).values({
      userId: parentUserId,
      familyId,
      phoneE164Encrypted: encryptString(PARENT_PHONE),
      phoneE164Hash: 'hash_no_personal_data',
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
    retrieveMock.mockResolvedValue({
      id: SESSION_ID,
      status: 'complete',
      payment_status: 'paid',
      amount_total: 5900,
      currency: 'cad',
      created,
      expires_at: created + 24 * 3600,
      client_reference_id: familyId,
      customer: 'cus_no_personal_data',
      customer_details: { email: PARENT_EMAIL, phone: PARENT_PHONE, name: PARENT_NAME },
      metadata: { familyId, tier: 'plus', priceId: 'price_plus' },
      subscription: { id: 'sub_no_personal_data', created: created + 10, status: 'active' },
    });

    const { GET } = await import('./route');
    const res = await GET(new Request(URL_WITH_ID));
    const text = await res.text();

    expect(JSON.parse(text)).toEqual({
      transactionId: SESSION_ID,
      value: 59,
      currency: 'CAD',
      paid: true,
      tier: 'plus',
      view: { state: 'plan_active', checkInDue: true },
    });
    expect(findDirectChatMock).toHaveBeenCalledWith(PARENT_PHONE);
    for (const personal of [
      'Riley',
      PARENT_EMAIL,
      PARENT_PHONE,
      familyId,
      parentUserId,
      CHAT_ID,
      'cus_no_personal_data',
      'firstName',
    ]) {
      expect(text).not.toContain(personal);
    }
  });
});
