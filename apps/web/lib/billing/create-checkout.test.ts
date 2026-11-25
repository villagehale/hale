import type { Database } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckoutSessionParams, StripeCheckoutClient } from './stripe-client.js';

// createBillingCheckout resolves the caller's family, creates the Stripe session
// via the injected client, and writes the billing-intent audit row (rule #6). We
// mock the family resolvers (their own DB reads are covered elsewhere) and inject a
// fake client + a fake db that records the audit insert. No live Stripe, no real DB.
const resolveFamilyMock = vi.fn();
const ensureUserMock = vi.fn();
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
  requireUserIdForUser: (...a: unknown[]) => ensureUserMock(...a),
}));

import { createBillingCheckout } from './create-checkout.js';

const CALLER = { externalAuthId: 'auth-1', customerEmail: 'parent@example.com' };

function fakeClient(url = 'https://checkout.stripe.com/c/pay/cs_test_1'): {
  client: StripeCheckoutClient;
  calls: CheckoutSessionParams[];
} {
  const calls: CheckoutSessionParams[] = [];
  return {
    client: {
      createCheckoutSession: async (params) => {
        calls.push(params);
        return { url };
      },
    },
    calls,
  };
}

function fakeDb(
  family: {
    planTier: string;
    stripeSubscriptionId: string | null;
    stripeCustomerId: string | null;
  } | null = {
    planTier: 'free',
    stripeSubscriptionId: null,
    stripeCustomerId: null,
  },
): { db: Database; audits: Array<Record<string, unknown>> } {
  const audits: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (family ? [family] : []),
        }),
      }),
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        audits.push(v);
      },
    }),
  } as unknown as Database;
  return { db, audits };
}

describe('createBillingCheckout', () => {
  beforeEach(() => {
    vi.stubEnv('CHECKOUT_SUCCESS_STATES_ENABLED', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('creates a session for the resolved family and returns its url', async () => {
    resolveFamilyMock.mockResolvedValue('fam-9');
    ensureUserMock.mockResolvedValue('user-9');
    const { client, calls } = fakeClient();
    const { db } = fakeDb();

    const result = await createBillingCheckout({
      tier: 'plus',
      period: 'annual',
      priceId: 'price_plus_annual',
      ...CALLER,
      database: db,
      client,
      origin: 'https://app.example.com',
      marketingOrigin: 'https://www.villagehale.com',
    });

    expect(result).toEqual({
      status: 'created',
      url: 'https://checkout.stripe.com/c/pay/cs_test_1',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      priceId: 'price_plus_annual',
      familyId: 'fam-9',
      tier: 'plus',
      period: 'annual',
      customerEmail: 'parent@example.com',
    });
    expect(calls[0]?.successUrl).toBe(
      'https://www.villagehale.com/checkout/success?session_id={CHECKOUT_SESSION_ID}',
    );
    expect(calls[0]?.idempotencyKey).toBeUndefined();
    expect(calls[0]?.cancelUrl).toBe('https://app.example.com/settings?checkout=cancelled#billing');
  });

  it('sends a cancelled founding checkout back to the founding confirmation page', async () => {
    resolveFamilyMock.mockResolvedValue('fam-9');
    ensureUserMock.mockResolvedValue('user-9');
    const { client, calls } = fakeClient();
    const { db } = fakeDb();

    await createBillingCheckout({
      tier: 'plus',
      period: 'annual',
      priceId: 'price_founding_cad',
      sku: 'promo_plus_annual',
      currency: 'CAD',
      ...CALLER,
      database: db,
      client,
      origin: 'https://app.example.com',
      marketingOrigin: 'https://www.villagehale.com',
    });

    expect(calls[0]?.cancelUrl).toBe(
      'https://app.example.com/settings/founding?checkout=cancelled',
    );
  });

  it.each([
    ['the settings default', {}],
    ['a founding SKU', { sku: 'promo_plus_annual' as const, currency: 'CAD' as const }],
    ['the /join page', { cancelUrl: 'https://app.example.com/join?checkout=cancelled' }],
  ])('with the page-state flag on, %s cancels back to pricing', async (_name, over) => {
    resolveFamilyMock.mockResolvedValue('fam-9');
    ensureUserMock.mockResolvedValue('user-9');
    const { client, calls } = fakeClient();
    const { db } = fakeDb();

    await createBillingCheckout({
      tier: 'plus',
      period: 'annual',
      priceId: 'price_founding_cad',
      ...CALLER,
      database: db,
      client,
      origin: 'https://app.example.com',
      marketingOrigin: 'https://www.villagehale.com/',
      env: { CHECKOUT_SUCCESS_STATES_ENABLED: 'true' },
      ...over,
    });

    expect(calls[0]?.cancelUrl).toBe('https://www.villagehale.com/pricing?checkout=cancelled');
  });

  it.each([undefined, 'TRUE', 'true\n'])(
    'with the page-state flag at %j, the cancel url stays where it is today',
    async (value) => {
      resolveFamilyMock.mockResolvedValue('fam-9');
      ensureUserMock.mockResolvedValue('user-9');
      const { client, calls } = fakeClient();
      const { db } = fakeDb();

      await createBillingCheckout({
        tier: 'plus',
        period: 'annual',
        priceId: 'price_plus_annual',
        ...CALLER,
        database: db,
        client,
        origin: 'https://app.example.com',
        marketingOrigin: 'https://www.villagehale.com',
        env: { CHECKOUT_SUCCESS_STATES_ENABLED: value },
      });

      expect(calls[0]?.cancelUrl).toBe(
        'https://app.example.com/settings?checkout=cancelled#billing',
      );
    },
  );

  it('writes a billing_checkout_started audit row for the family (rule #6)', async () => {
    resolveFamilyMock.mockResolvedValue('fam-9');
    ensureUserMock.mockResolvedValue('user-9');
    const { client } = fakeClient();
    const { db, audits } = fakeDb();

    await createBillingCheckout({
      tier: 'family',
      period: 'monthly',
      priceId: 'price_family_monthly',
      ...CALLER,
      database: db,
      client,
      origin: 'https://app.example.com',
      marketingOrigin: 'https://www.villagehale.com',
    });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      familyId: 'fam-9',
      actor: 'user-9',
      actionTaken: 'billing_checkout_started',
      targetTable: 'families',
      targetId: 'fam-9',
      after: { tier: 'family', period: 'monthly', sku: null, currency: null },
    });
  });

  it('returns not_found when the caller has no family (never creates a session)', async () => {
    resolveFamilyMock.mockResolvedValue(null);
    const { client, calls } = fakeClient();
    const { db, audits } = fakeDb();

    const result = await createBillingCheckout({
      tier: 'plus',
      period: 'monthly',
      priceId: 'price_plus_monthly',
      ...CALLER,
      database: db,
      client,
      origin: 'https://app.example.com',
      marketingOrigin: 'https://www.villagehale.com',
    });

    expect(result).toEqual({ status: 'not_found' });
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('lets Stripe collect the address when the caller has none (a phone-claimed family)', async () => {
    resolveFamilyMock.mockResolvedValue('fam-9');
    ensureUserMock.mockResolvedValue('user-9');
    const { client, calls } = fakeClient();
    const { db } = fakeDb();

    const result = await createBillingCheckout({
      tier: 'plus',
      period: 'monthly',
      priceId: 'price_plus_monthly',
      externalAuthId: 'sms:9f2c4e1a',
      customerEmail: null,
      database: db,
      client,
      origin: 'https://app.example.com',
      marketingOrigin: 'https://www.villagehale.com',
    });

    // A family that arrived by text has no address on file. Refusing checkout over that
    // would lock every phone-born family out of paying forever; Stripe asks for one on
    // its own page instead, which is where a billing address belongs anyway.
    expect(result.status).toBe('created');
    expect(calls[0]?.customerEmail).toBeNull();
  });

  it('returns already_paid and creates no session when the family is on Plus', async () => {
    resolveFamilyMock.mockResolvedValue('fam-9');
    ensureUserMock.mockResolvedValue('user-9');
    const { client, calls } = fakeClient();
    const { db, audits } = fakeDb({
      planTier: 'plus',
      stripeSubscriptionId: 'sub_live',
      stripeCustomerId: 'cus_1',
    });

    const result = await createBillingCheckout({
      tier: 'plus',
      period: 'annual',
      priceId: 'price_founding',
      ...CALLER,
      database: db,
      client,
      origin: 'https://app.example.com',
      marketingOrigin: 'https://www.villagehale.com',
    });

    expect(result).toEqual({ status: 'already_paid' });
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('lets a cancelled household (free, leftover Stripe id) open checkout again', async () => {
    resolveFamilyMock.mockResolvedValue('fam-9');
    ensureUserMock.mockResolvedValue('user-9');
    const { client, calls } = fakeClient();
    const { db } = fakeDb({
      planTier: 'free',
      stripeSubscriptionId: 'sub_old',
      stripeCustomerId: 'cus_existing',
    });

    const result = await createBillingCheckout({
      tier: 'plus',
      period: 'annual',
      priceId: 'price_founding',
      ...CALLER,
      database: db,
      client,
      origin: 'https://app.example.com',
      marketingOrigin: 'https://www.villagehale.com',
    });

    expect(result.status).toBe('created');
    expect(calls[0]?.customerId).toBe('cus_existing');
  });

  it('reuses the Stripe Customer and honors a founding cancel URL', async () => {
    resolveFamilyMock.mockResolvedValue('fam-9');
    ensureUserMock.mockResolvedValue('user-9');
    const { client, calls } = fakeClient();
    const { db } = fakeDb({
      planTier: 'free',
      stripeSubscriptionId: null,
      stripeCustomerId: 'cus_existing',
    });

    await createBillingCheckout({
      tier: 'plus',
      period: 'annual',
      priceId: 'price_founding',
      ...CALLER,
      database: db,
      client,
      origin: 'https://app.example.com',
      marketingOrigin: 'https://www.villagehale.com',
      cancelUrl: 'https://app.example.com/join?checkout=cancelled',
      familyId: 'fam-9',
    });

    expect(calls[0]?.customerId).toBe('cus_existing');
    expect(calls[0]?.customerEmail).toBeNull();
    expect(calls[0]?.cancelUrl).toBe('https://app.example.com/join?checkout=cancelled');
  });

  it('refuses a list price while the promo window is open', async () => {
    resolveFamilyMock.mockResolvedValue('fam-9');
    ensureUserMock.mockResolvedValue('user-9');
    const { client, calls } = fakeClient();
    const { db, audits } = fakeDb();

    const result = await createBillingCheckout({
      tier: 'plus',
      period: 'monthly',
      priceId: 'price_cad_mo',
      sku: 'plus_monthly',
      ...CALLER,
      database: db,
      client,
      origin: 'https://app.example.com',
      marketingOrigin: 'https://www.villagehale.com',
      now: new Date('2026-11-16T12:00:00-05:00'),
      env: {
        HOLIDAY_PROMO_ENABLED: 'true',
        STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD: 'price_founding_cad',
        STRIPE_PRICE_PLUS_MONTHLY: 'price_cad_mo',
      },
    });

    expect(result).toEqual({ status: 'founding_only' });
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });
});
