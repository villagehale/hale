import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { resolveNoticePayer } from './payer';

/**
 * VIL-735 · who owns a payment. Nothing stores it, so it is read from the audit row of
 * the checkout the parent started, bound to that session's own time. Anything less than
 * exactly one parent sends nothing: a payment text must never reach the other adult.
 */

const SESSION_AT = new Date('2026-11-22T17:00:00Z');
const at = (seconds: number) => new Date(SESSION_AT.getTime() + seconds * 1000);

let db: TestDb;
let familyId: string;
let parentA: string;
let parentB: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  ({ familyId, parentUserId: parentA } = await seedFamily(db.database));
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `${familyId}-b@example.test`, name: 'Second Parent' })
    .returning({ id: schema.users.id });
  parentB = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: parentB, role: 'co_parent' });
});

async function started(actor: string, occurredAt: Date) {
  await db.database.insert(schema.auditLog).values({
    familyId,
    actor,
    actionTaken: 'billing_checkout_started',
    targetTable: 'families',
    targetId: familyId,
    after: { tier: 'plus', period: 'annual' },
    occurredAt,
  });
}

const paymentNotice = (over: Record<string, unknown> = {}) => ({
  familyId,
  lane: 'payment' as const,
  parentUserId: null,
  facts: {
    eventIds: ['evt_1'],
    sessionCreatedAt: SESSION_AT.toISOString(),
    sessionTier: 'plus' as const,
    subscriptionId: 'sub_a',
  },
  ...over,
});

const planChange = (facts: Record<string, unknown>) => ({
  familyId,
  lane: 'plan_change' as const,
  parentUserId: null,
  facts: { eventIds: ['evt_2'], ...facts },
});

async function seedPaid(parentUserId: string, subscriptionId: string) {
  await db.database.insert(schema.billingNotices).values({
    familyId,
    lane: 'payment',
    status: 'sent',
    parentUserId,
    facts: { eventIds: [`evt_${subscriptionId}`], subscriptionId, sessionTier: 'plus' },
    lastEventAt: SESSION_AT,
    nextTryAt: SESSION_AT,
  });
}

describe('the payment lane', () => {
  it('names the parent whose checkout matches the session, when the other started one later', async () => {
    await started(parentA, at(2));
    await started(parentB, at(3600));
    await expect(resolveNoticePayer(db.database, paymentNotice())).resolves.toEqual({
      status: 'resolved',
      parentUserId: parentA,
    });
  });

  it('two parents inside one session window is unresolved', async () => {
    await started(parentA, at(1));
    await started(parentB, at(5));
    await expect(resolveNoticePayer(db.database, paymentNotice())).resolves.toEqual({
      status: 'payer_unresolved',
    });
  });

  it('nothing in the window falls back to the only parent who ever started a checkout', async () => {
    await started(parentB, at(-7200));
    await expect(resolveNoticePayer(db.database, paymentNotice())).resolves.toEqual({
      status: 'resolved',
      parentUserId: parentB,
    });
  });

  it('nothing in the window with two past actors is unresolved', async () => {
    await started(parentA, at(-7200));
    await started(parentB, at(-3600));
    await expect(resolveNoticePayer(db.database, paymentNotice())).resolves.toEqual({
      status: 'payer_unresolved',
    });
  });

  it('no checkout row at all is unresolved, never the primary parent', async () => {
    await expect(resolveNoticePayer(db.database, paymentNotice())).resolves.toEqual({
      status: 'payer_unresolved',
    });
  });

  it('a payer who has left the family is recipient_gone', async () => {
    await started(parentB, at(1));
    await db.database.delete(schema.familyMembers).where(eq(schema.familyMembers.userId, parentB));
    await expect(resolveNoticePayer(db.database, paymentNotice())).resolves.toEqual({
      status: 'recipient_gone',
    });
  });

  it('a seat without a parent role is recipient_gone', async () => {
    await started(parentB, at(1));
    await db.database
      .update(schema.familyMembers)
      .set({ role: 'extended' })
      .where(eq(schema.familyMembers.userId, parentB));
    await expect(resolveNoticePayer(db.database, paymentNotice())).resolves.toEqual({
      status: 'recipient_gone',
    });
  });
});

describe('the plan-change lane', () => {
  it('a cancel with one distinct actor resolves to them', async () => {
    await started(parentA, at(-86_400));
    await expect(
      resolveNoticePayer(
        db.database,
        planChange({ ended: { subscriptionId: 'sub_a', why: 'cancelled' } }),
      ),
    ).resolves.toEqual({ status: 'resolved', parentUserId: parentA });
  });

  it('two actors and no payment notice for that subscription is unresolved', async () => {
    await started(parentA, at(-86_400));
    await started(parentB, at(-3600));
    await expect(
      resolveNoticePayer(
        db.database,
        planChange({ ended: { subscriptionId: 'sub_a', why: 'cancelled' } }),
      ),
    ).resolves.toEqual({ status: 'payer_unresolved' });
  });

  it('a refund of the first parent’s old charge after the other rebought reaches the first', async () => {
    await started(parentA, at(-86_400));
    await started(parentB, at(-3600));
    await seedPaid(parentA, 'sub_old');
    await seedPaid(parentB, 'sub_new');
    await expect(
      resolveNoticePayer(
        db.database,
        planChange({
          refunds: [
            {
              chargeId: 'ch_old',
              refundedMinor: 100,
              chargeMinor: 100,
              currency: 'cad',
              full: true,
              subscriptionId: 'sub_old',
            },
          ],
        }),
      ),
    ).resolves.toEqual({ status: 'resolved', parentUserId: parentA });
  });

  it('a notice whose subscriptions belong to two parents tells nobody', async () => {
    await started(parentA, at(-86_400));
    await started(parentB, at(-3600));
    await seedPaid(parentA, 'sub_old');
    await seedPaid(parentB, 'sub_new');
    await expect(
      resolveNoticePayer(
        db.database,
        planChange({
          ended: { subscriptionId: 'sub_new', why: 'cancelled' },
          refunds: [
            {
              chargeId: 'ch_old',
              refundedMinor: 100,
              chargeMinor: 100,
              currency: 'cad',
              full: true,
              subscriptionId: 'sub_old',
            },
          ],
        }),
      ),
    ).resolves.toEqual({ status: 'payer_unresolved' });
  });

  it('a charge with no subscription falls back to the single actor', async () => {
    await started(parentB, at(-86_400));
    await expect(
      resolveNoticePayer(
        db.database,
        planChange({
          refunds: [
            {
              chargeId: 'ch_one_off',
              refundedMinor: 100,
              chargeMinor: 100,
              currency: 'cad',
              full: true,
              subscriptionId: null,
            },
          ],
        }),
      ),
    ).resolves.toEqual({ status: 'resolved', parentUserId: parentB });
  });
});
