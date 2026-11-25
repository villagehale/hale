import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ErasureBillingDeps, endBillingForFamilyErasure } from '~/lib/billing/erasure-billing';
import { type FakeStripe, createFakeStripe, stripeError } from '~/lib/testing/fake-stripe';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { runDeletionSweep } from './delete';

/**
 * A family erased while Stripe still bills it. With both refund flags on, the sweep ends
 * every subscription Stripe still has for the family before the family row goes, and keeps
 * the family for the next sweep, paged, when Stripe will not end one.
 */

const FLAGS_ON = {
  STRIPE_SECRET_KEY: 'sk_test_fixture',
  STRIPE_BILLING_REVOKE_ENABLED: 'true',
  STRIPE_REFUND_ENDS_SUBSCRIPTION_ENABLED: 'true',
};
const NOW = new Date('2026-11-20T12:00:00.000Z');
const NOW_S = Math.floor(NOW.getTime() / 1000);
const DAY = 86_400;
const PAST = new Date(NOW.getTime() - 60_000);

let db: TestDb;
let serial = 0;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  serial += 1;
  vi.stubGlobal('fetch', () => {
    throw new Error('a test reached the global fetch');
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.exec('truncate table families, users, rate_limits cascade');
});

async function dueFamily(suffix: string | null): Promise<string> {
  const { familyId } = await seedFamily(db.database, 'Erased family');
  await db.database
    .update(schema.families)
    .set({
      planTier: suffix ? 'plus' : 'free',
      stripeCustomerId: suffix ? `cus_${suffix}` : null,
      stripeSubscriptionId: suffix ? `sub_${suffix}` : null,
      scheduledDeletionAt: PAST,
    })
    .where(eq(schema.families.id, familyId));
  return familyId;
}

function live(fake: FakeStripe, id: string, customer: string, familyId: string | null): void {
  fake.addSubscription({
    id,
    customer,
    familyId,
    created: NOW_S - 30 * DAY,
    periodStart: NOW_S - 30 * DAY,
    periodEnd: NOW_S + 335 * DAY,
  });
}

async function familyStands(familyId: string): Promise<boolean> {
  const rows = await db.database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.id, familyId));
  return rows.length === 1;
}

function billingDeps(fake: FakeStripe, pages: string[], env = FLAGS_ON): ErasureBillingDeps {
  return {
    env,
    stripeFetch: fake.fetch,
    pageDeps: {
      post: async (text) => {
        pages.push(text);
        return 'sent';
      },
      now: new Date(NOW.getTime() + serial * 3_600_000),
    },
  };
}

const noPager = async () => ({ posted: 0, deduped: 0, failed: 0 });

describe('erasing a family Stripe still bills', () => {
  it('production wiring: the live subscription is cancelled before the family row is deleted', async () => {
    const fake = createFakeStripe();
    const suffix = `wired${serial}`;
    const familyId = await dueFamily(suffix);
    live(fake, `sub_${suffix}`, `cus_${suffix}`, familyId);
    for (const [name, value] of Object.entries(FLAGS_ON)) vi.stubEnv(name, value);
    vi.stubGlobal('fetch', fake.fetch);
    let standingAtCancel: boolean | null = null;
    fake.duringDelete(async () => {
      standingAtCancel = await familyStands(familyId);
    });

    const summary = await runDeletionSweep(db.database, NOW, async () => {}, noPager);

    expect(fake.deletes()).toEqual([`sub_${suffix}`]);
    expect(standingAtCancel).toBe(true);
    const cancel = fake.calls.find((call) => call.method === 'DELETE');
    expect(cancel?.body).toBe('prorate=false&invoice_now=false');
    expect(fake.subscriptions.get(`sub_${suffix}`)?.status).toBe('canceled');
    expect(await familyStands(familyId)).toBe(false);
    expect(summary.erased).toBe(1);
    expect(summary.erasureBilling).toEqual({ cancelled: 1, notEnded: 0 });
  });

  it('a subscription on the same customer that names another family is left alone', async () => {
    const fake = createFakeStripe();
    const pages: string[] = [];
    const suffix = `shared${serial}`;
    const familyId = await dueFamily(suffix);
    live(fake, `sub_${suffix}`, `cus_${suffix}`, familyId);
    live(fake, `sub_other_${suffix}`, `cus_${suffix}`, '00000000-0000-4000-8000-0000000000aa');

    const summary = await runDeletionSweep(
      db.database,
      NOW,
      async () => {},
      noPager,
      (id) => endBillingForFamilyErasure(db.database, id, billingDeps(fake, pages)),
    );

    expect(fake.deletes()).toEqual([`sub_${suffix}`]);
    expect(fake.subscriptions.get(`sub_other_${suffix}`)?.status).toBe('active');
    expect(await familyStands(familyId)).toBe(false);
    expect(summary.erasureBilling).toEqual({ cancelled: 1, notEnded: 0 });
    expect(pages).toEqual([]);
  });

  it('a cancel Stripe refuses keeps the family for the next sweep and pages #ops', async () => {
    const fake = createFakeStripe();
    const pages: string[] = [];
    const suffix = `refused${serial}`;
    const familyId = await dueFamily(suffix);
    live(fake, `sub_${suffix}`, `cus_${suffix}`, familyId);
    fake.intercept(
      (call) => call.method === 'DELETE',
      () => stripeError(403),
      1,
    );
    const sweep = () =>
      runDeletionSweep(
        db.database,
        NOW,
        async () => {},
        noPager,
        (id) => endBillingForFamilyErasure(db.database, id, billingDeps(fake, pages)),
      );

    const first = await sweep();

    expect(await familyStands(familyId)).toBe(true);
    expect(fake.subscriptions.get(`sub_${suffix}`)?.status).toBe('active');
    expect(first.erased).toBe(0);
    expect(first.erasureBilling).toEqual({ cancelled: 0, notEnded: 1 });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('erasure_billing_not_ended');
    expect(pages[0]).toContain('stripe_refused');

    const second = await sweep();

    expect(fake.subscriptions.get(`sub_${suffix}`)?.status).toBe('canceled');
    expect(await familyStands(familyId)).toBe(false);
    expect(second.erasureBilling).toEqual({ cancelled: 1, notEnded: 0 });
  });

  it('a family whose row holds no Stripe id is still found by its metadata and cancelled', async () => {
    const fake = createFakeStripe();
    const pages: string[] = [];
    const familyId = await dueFamily(null);
    live(fake, `sub_meta${serial}`, `cus_meta${serial}`, familyId);

    const summary = await runDeletionSweep(
      db.database,
      NOW,
      async () => {},
      noPager,
      (id) => endBillingForFamilyErasure(db.database, id, billingDeps(fake, pages)),
    );

    expect(fake.deletes()).toEqual([`sub_meta${serial}`]);
    expect(fake.subscriptions.get(`sub_meta${serial}`)?.status).toBe('canceled');
    expect(await familyStands(familyId)).toBe(false);
    expect(summary.erasureBilling).toEqual({ cancelled: 1, notEnded: 0 });
    expect(pages).toEqual([]);
  });

  it('a refund-ready subscription search has not indexed yet is cancelled before erasure', async () => {
    const fake = createFakeStripe();
    const pages: string[] = [];
    const familyId = await dueFamily(null);
    const subscriptionId = `sub_ready${serial}`;
    live(fake, subscriptionId, `cus_ready${serial}`, familyId);
    fake.unindexed.add(subscriptionId);
    await db.database.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'billing_refund_ready',
      targetTable: 'families',
      targetId: familyId,
      after: { stripeEventId: `evt_ready${serial}`, subscriptionId, refund: 'ready' },
    });

    const summary = await runDeletionSweep(
      db.database,
      NOW,
      async () => {},
      noPager,
      (id) => endBillingForFamilyErasure(db.database, id, billingDeps(fake, pages)),
    );

    expect(fake.deletes()).toEqual([subscriptionId]);
    expect(fake.subscriptions.get(subscriptionId)?.status).toBe('canceled');
    expect(await familyStands(familyId)).toBe(false);
    expect(summary.erasureBilling).toEqual({ cancelled: 1, notEnded: 0 });
    expect(pages).toEqual([]);
  });

  it('a subscription list Stripe cut short keeps the family for the next sweep and pages #ops', async () => {
    const fake = createFakeStripe();
    const pages: string[] = [];
    const suffix = `cut${serial}`;
    const familyId = await dueFamily(suffix);
    live(fake, `sub_${suffix}`, `cus_${suffix}`, familyId);
    fake.intercept(
      (call) => call.path === '/v1/subscriptions/search',
      () => Response.json({ object: 'search_result', has_more: true, data: [] }),
      1,
    );

    const summary = await runDeletionSweep(
      db.database,
      NOW,
      async () => {},
      noPager,
      (id) => endBillingForFamilyErasure(db.database, id, billingDeps(fake, pages)),
    );

    expect(fake.deletes()).toEqual([`sub_${suffix}`]);
    expect(await familyStands(familyId)).toBe(true);
    expect(summary.erased).toBe(0);
    expect(summary.erasureBilling.notEnded).toBe(1);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toContain('erasure_billing_not_ended');
    expect(pages[0]).toContain('truncated');
  });

  it('positive control: a family Stripe has no subscription for is erased after one search', async () => {
    const fake = createFakeStripe();
    const pages: string[] = [];
    const familyId = await dueFamily(null);

    const summary = await runDeletionSweep(
      db.database,
      NOW,
      async () => {},
      noPager,
      (id) => endBillingForFamilyErasure(db.database, id, billingDeps(fake, pages)),
    );

    expect(await familyStands(familyId)).toBe(false);
    expect(fake.calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/subscriptions/search',
    ]);
    expect(summary.erasureBilling).toEqual({ cancelled: 0, notEnded: 0 });
    expect(pages).toEqual([]);
  });

  for (const off of ['STRIPE_REFUND_ENDS_SUBSCRIPTION_ENABLED', 'STRIPE_BILLING_REVOKE_ENABLED']) {
    it(`${off} off: nothing is read or cancelled and the family is erased, as on main`, async () => {
      const fake = createFakeStripe();
      const pages: string[] = [];
      const suffix = `off${serial}`;
      const familyId = await dueFamily(suffix);
      live(fake, `sub_${suffix}`, `cus_${suffix}`, familyId);

      await runDeletionSweep(
        db.database,
        NOW,
        async () => {},
        noPager,
        (id) =>
          endBillingForFamilyErasure(
            db.database,
            id,
            billingDeps(fake, pages, { ...FLAGS_ON, [off]: 'false' }),
          ),
      );

      expect(fake.calls).toEqual([]);
      expect(await familyStands(familyId)).toBe(false);
      expect(pages).toEqual([]);
    });
  }
});
