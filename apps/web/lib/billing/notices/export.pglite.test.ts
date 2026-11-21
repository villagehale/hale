import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assembleFamilyExport } from '~/lib/rights/export';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { writeNoticeAudit } from './store';

/**
 * VIL-735 · a billing notice is about one adult's money. Each adult's access copy carries
 * their own notices with their amounts; a row with no resolved payer appears in both
 * copies with none, and no row carries a Stripe id.
 */

const NOW = new Date('2026-11-23T18:00:00Z');

let db: TestDb;
let familyId: string;
let anaId: string;
let samId: string;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  ({ familyId, parentUserId: anaId } = await seedFamily(db.database));
  const [user] = await db.database
    .insert(schema.users)
    .values({ email: `${familyId}-sam@example.test`, name: 'Sam' })
    .returning({ id: schema.users.id });
  samId = user?.id as string;
  await db.database
    .insert(schema.familyMembers)
    .values({ familyId, userId: samId, role: 'co_parent' });
});

async function notice(parentUserId: string | null, over: Record<string, unknown> = {}) {
  const [row] = await db.database
    .insert(schema.billingNotices)
    .values({
      familyId,
      parentUserId,
      lane: 'plan_change',
      status: 'sent',
      facts: {
        eventIds: ['evt_private_id'],
        refunds: [
          {
            chargeId: 'ch_private_id',
            refundedMinor: 15900,
            chargeMinor: 15900,
            currency: 'cad',
            full: true,
            subscriptionId: 'sub_private_id',
          },
        ],
      },
      lastEventAt: NOW,
      nextTryAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      ...over,
    })
    .returning();
  return row as NonNullable<typeof row>;
}

const copyFor = (actorUserId: string) =>
  assembleFamilyExport(db.database, familyId, { actorUserId, now: NOW });

describe('billing notices in the access copy', () => {
  it('a parent gets their own notice with its amount, and the other parent gets nothing', async () => {
    await notice(anaId);
    const ana = await copyFor(anaId);
    expect(ana.requesterOnly.billingNotices).toEqual([
      {
        lane: 'plan_change',
        status: 'sent',
        reason: null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
        refunds: [{ refundedMinor: 15900, chargeMinor: 15900, currency: 'cad' }],
      },
    ]);
    const sam = await copyFor(samId);
    expect(sam.requesterOnly.billingNotices).toEqual([]);
    expect(JSON.stringify(sam)).not.toContain('15900');
  });

  it('a row with no resolved payer is in both copies, with no amount', async () => {
    await notice(null, {
      status: 'dropped',
      dropReason: 'payer_unresolved',
      facts: {
        eventIds: ['evt_private_id'],
        refunds: [{ chargeId: 'ch_private_id', currency: 'cad', full: true }],
      },
    });
    for (const parent of [anaId, samId]) {
      const copy = await copyFor(parent);
      expect(copy.requesterOnly.billingNotices).toEqual([
        {
          lane: 'plan_change',
          status: 'dropped',
          reason: 'payer_unresolved',
          createdAt: NOW.toISOString(),
          updatedAt: NOW.toISOString(),
          refunds: [],
        },
      ]);
    }
  });

  it('no Stripe id reaches any copy', async () => {
    await notice(anaId);
    const text = JSON.stringify((await copyFor(anaId)).requesterOnly.billingNotices);
    expect(text).toContain('15900');
    expect(text).not.toContain('private_id');
  });

  it('the audit rows stay out of the family-wide trail of every adult', async () => {
    const row = await notice(anaId);
    await writeNoticeAudit.sent(db.database, row, { attempts: 0 });
    await writeNoticeAudit.dropped(db.database, row, { reason: 'no_thread', attempts: 0 });
    await writeNoticeAudit.failed(db.database, row, { reason: 'unwritten', attempts: 1 });
    const stored = await db.database
      .select({ verb: schema.auditLog.actionTaken, audience: schema.auditLog.audience })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.targetId, row.id));
    expect(stored.map((a) => a.verb).sort()).toEqual([
      'billing_notice_dropped',
      'billing_notice_send_failed',
      'billing_notice_sent',
    ]);
    expect(new Set(stored.map((a) => a.audience))).toEqual(new Set([anaId]));
    for (const parent of [anaId, samId]) {
      const copy = await copyFor(parent);
      expect(JSON.stringify(copy.trail)).not.toContain('billing_notice');
    }
  });
});
