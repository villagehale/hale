import type { Database } from '@hale/db';
import { describe, expect, it } from 'vitest';
import { refundFamilyLatestPayment, type StripeRefundApi } from './refund-family.js';

function fakeDb(family: { id: string; stripeCustomerId: string | null; stripeSubscriptionId: string | null } | null): {
  db: Database;
  audits: Array<Record<string, unknown>>;
} {
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

function fakeStripe(): StripeRefundApi & { refunds: string[]; cancelled: string[] } {
  const refunds: string[] = [];
  const cancelled: string[] = [];
  return {
    refunds,
    cancelled,
    latestPaidCharge: async () => ({ chargeId: 'ch_1', paymentIntentId: 'pi_1' }),
    refundCharge: async (chargeId) => {
      refunds.push(chargeId);
      return { refundId: 're_1' };
    },
    cancelSubscription: async (id) => {
      cancelled.push(id);
    },
  };
}

describe('refundFamilyLatestPayment', () => {
  it('skips not_configured when Stripe is absent', async () => {
    const { db } = fakeDb({
      id: 'fam-1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
    });
    expect(
      await refundFamilyLatestPayment({ familyId: 'fam-1', apply: true, database: db, stripe: null }),
    ).toEqual({ status: 'skipped', reason: 'not_configured' });
  });

  it('dry-runs the latest charge without refunding', async () => {
    const { db, audits } = fakeDb({
      id: 'fam-1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
    });
    const stripe = fakeStripe();
    const result = await refundFamilyLatestPayment({
      familyId: 'fam-1',
      apply: false,
      database: db,
      stripe,
    });
    expect(result).toEqual({
      status: 'dry_run',
      familyId: 'fam-1',
      chargeId: 'ch_1',
      subscriptionId: 'sub_1',
    });
    expect(stripe.refunds).toEqual([]);
    expect(stripe.cancelled).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('refunds the latest payment, cancels, and writes an audit row', async () => {
    const { db, audits } = fakeDb({
      id: 'fam-1',
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
    });
    const stripe = fakeStripe();
    const result = await refundFamilyLatestPayment({
      familyId: 'fam-1',
      apply: true,
      database: db,
      stripe,
      actor: 'ops',
    });
    expect(result).toEqual({
      status: 'refunded',
      familyId: 'fam-1',
      refundId: 're_1',
      subscriptionId: 'sub_1',
    });
    expect(stripe.refunds).toEqual(['ch_1']);
    expect(stripe.cancelled).toEqual(['sub_1']);
    expect(audits[0]).toMatchObject({
      familyId: 'fam-1',
      actor: 'ops',
      actionTaken: 'billing_refunded',
    });
  });

  it('skips no_customer when the family has never checked out', async () => {
    const { db } = fakeDb({
      id: 'fam-1',
      stripeCustomerId: null,
      stripeSubscriptionId: null,
    });
    expect(
      await refundFamilyLatestPayment({
        familyId: 'fam-1',
        apply: true,
        database: db,
        stripe: fakeStripe(),
      }),
    ).toEqual({ status: 'skipped', reason: 'no_customer' });
  });
});
