import type { Database } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import type { CheckoutSessionParams, StripeCheckoutClient } from './stripe-client.js';

// createBillingCheckout resolves the caller's family, creates the Stripe session
// via the injected client, and writes the billing-intent audit row (rule #6). We
// mock the family resolvers (their own DB reads are covered elsewhere) and inject a
// fake client + a fake db that records the audit insert. No live Stripe, no real DB.
const resolveFamilyMock = vi.fn();
const ensureUserMock = vi.fn();
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
  ensureUserRow: (...a: unknown[]) => ensureUserMock(...a),
}));

import { createBillingCheckout } from './create-checkout.js';

const IDENTITY = { externalAuthId: 'auth-1', email: 'parent@example.com', name: 'Parent' };

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

function fakeDb(): { db: Database; audits: Array<Record<string, unknown>> } {
  const audits: Array<Record<string, unknown>> = [];
  const db = {
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        audits.push(v);
      },
    }),
  } as unknown as Database;
  return { db, audits };
}

describe('createBillingCheckout', () => {
  it('creates a session for the resolved family and returns its url', async () => {
    resolveFamilyMock.mockResolvedValue('fam-9');
    ensureUserMock.mockResolvedValue('user-9');
    const { client, calls } = fakeClient();
    const { db } = fakeDb();

    const result = await createBillingCheckout({
      tier: 'plus',
      period: 'annual',
      priceId: 'price_plus_annual',
      identity: IDENTITY,
      database: db,
      client,
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({ status: 'created', url: 'https://checkout.stripe.com/c/pay/cs_test_1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      priceId: 'price_plus_annual',
      familyId: 'fam-9',
      tier: 'plus',
      period: 'annual',
      customerEmail: 'parent@example.com',
    });
    expect(calls[0]?.successUrl).toContain('https://app.example.com');
  });

  it('writes a billing_checkout_started audit row for the family (rule #6)', async () => {
    resolveFamilyMock.mockResolvedValue('fam-9');
    ensureUserMock.mockResolvedValue('user-9');
    const { client } = fakeClient();
    const { db, audits } = fakeDb();

    await createBillingCheckout({
      tier: 'family',
      period: 'monthly',
      priceId: 'price_family_monthly',
      identity: IDENTITY,
      database: db,
      client,
      origin: 'https://app.example.com',
    });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      familyId: 'fam-9',
      actor: 'user-9',
      actionTaken: 'billing_checkout_started',
      targetTable: 'families',
      targetId: 'fam-9',
      after: { tier: 'family', period: 'monthly' },
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
      identity: IDENTITY,
      database: db,
      client,
      origin: 'https://app.example.com',
    });

    expect(result).toEqual({ status: 'not_found' });
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });
});
