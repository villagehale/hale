import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { logCrisisUnanswered } from '~/lib/channel/voice/said-line';
import {
  CRISIS_UNANSWERED_AUDIT_ACTION,
  failurePageCrisisPager,
} from '~/lib/monitoring/failure-page';
import { AUDIT_LOG_AUDIENCE_ENABLED_ENV } from '~/lib/privacy/audit-audience';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { assembleFamilyExport } from './export';

/**
 * A crisis flag about one adult is never visible to another adult in the family. The
 * family-wide access copy goes to every parent seat, so the `crisis_unanswered` row
 * stays out of every copy but the one the parent it is about asks for (right of
 * access). Real DDL and the real crisis pager; only the Slack post is faked.
 */

const NOW = new Date('2026-07-30T12:00:00.000Z');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await db.exec('truncate table families, users, rate_limits cascade');
});

async function seedCoParent(familyId: string): Promise<string> {
  const [user] = await db.database
    .insert(schema.users)
    .values({ externalAuthId: `sms:${familyId}:co`, name: 'Robin' })
    .returning({ id: schema.users.id });
  const userId = user?.id as string;
  await db.database.insert(schema.familyMembers).values({ familyId, userId, role: 'co_parent' });
  return userId;
}

describe('a crisis flag in the family data export', () => {
  it("is in the texting parent's own copy only; another internal row is in both", async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { familyId, parentUserId: texter } = await seedFamily(db.database, 'Juniper Family');
    const coParent = await seedCoParent(familyId);
    const pager = failurePageCrisisPager(db.database, { post: async () => 'sent', now: NOW });

    const page = await logCrisisUnanswered(pager, {
      kind: 'mental',
      where: 'intake crisis',
      reason: 'write_failed',
      writes: 2,
      inboundId: 'provider-inbound-export-1',
      familyId,
      parentUserId: texter,
    });
    expect(page).toBe('paged');

    const [crisis] = await db.database
      .select({
        id: schema.auditLog.id,
        targetTable: schema.auditLog.targetTable,
        targetId: schema.auditLog.targetId,
      })
      .from(schema.auditLog)
      .where(eq(schema.auditLog.actionTaken, CRISIS_UNANSWERED_AUDIT_ACTION));
    // The row names the parent who texted, so a per-parent copy could return it to them.
    expect(crisis).toMatchObject({ targetTable: 'users', targetId: texter });

    // The 7-day unsent mark: another verb History hides, which the export keeps.
    const [agedOut] = await db.database
      .insert(schema.auditLog)
      .values({ familyId, actor: 'system', actionTaken: 'autonomy_acted_notice_aged_out' })
      .returning({ id: schema.auditLog.id });

    const own = await assembleFamilyExport(db.database, familyId, {
      actorUserId: texter,
      now: NOW,
    });
    expect(own.trail.map((row) => row.id)).toEqual(
      expect.arrayContaining([crisis?.id, agedOut?.id]),
    );
    const other = await assembleFamilyExport(db.database, familyId, {
      actorUserId: coParent,
      now: NOW,
    });
    expect(other.trail.map((row) => row.id)).not.toContain(crisis?.id);
    expect(other.trail.map((row) => row.id)).toContain(agedOut?.id);
  }, 30_000);

  it("leaves another adult's crisis rows out in the query, so they never crowd out a row the copy keeps", async () => {
    const { familyId, parentUserId } = await seedFamily(db.database, 'Alder Family');
    const coParent = await seedCoParent(familyId);
    const [older] = await db.database
      .insert(schema.auditLog)
      .values({
        familyId,
        actor: 'system',
        actionTaken: 'autonomy_acted_notice_aged_out',
        occurredAt: new Date(NOW.getTime() - 3_600_000),
      })
      .returning({ id: schema.auditLog.id });
    // More crisis rows than the trail reads in one go, all newer than the row the copy keeps.
    await db.database.insert(schema.auditLog).values(
      Array.from({ length: 60 }, (_, i) => ({
        familyId,
        actor: 'system' as const,
        actionTaken: CRISIS_UNANSWERED_AUDIT_ACTION,
        targetTable: 'users',
        targetId: parentUserId,
        occurredAt: new Date(NOW.getTime() - i * 1_000),
      })),
    );

    const copy = await assembleFamilyExport(db.database, familyId, {
      actorUserId: coParent,
      now: NOW,
    });
    expect(copy.trail.map((row) => row.id)).toEqual([older?.id]);
    // Positive control: the same rows are the texting parent's own, so their copy holds them.
    const own = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentUserId,
      now: NOW,
    });
    expect(own.trail.filter((row) => row.id !== older?.id)).toHaveLength(50);
  }, 30_000);

  it("with audience rows lit, an own row written before the column is still in its adult's copy only", async () => {
    vi.stubEnv(AUDIT_LOG_AUDIENCE_ENABLED_ENV, 'true');
    const { familyId, parentUserId } = await seedFamily(db.database, 'Hazel Family');
    const coParent = await seedCoParent(familyId);
    const [heldRead] = await db.database
      .insert(schema.auditLog)
      .values({
        familyId,
        actor: 'system',
        actionTaken: 'opt_out_hold_read',
        targetTable: 'users',
        targetId: parentUserId,
      })
      .returning({ id: schema.auditLog.id, audience: schema.auditLog.audience });
    expect(heldRead?.audience).toBeNull();

    const own = await assembleFamilyExport(db.database, familyId, {
      actorUserId: parentUserId,
      now: NOW,
    });
    expect(own.trail.map((row) => row.id)).toEqual([heldRead?.id]);
    const other = await assembleFamilyExport(db.database, familyId, {
      actorUserId: coParent,
      now: NOW,
    });
    expect(other.trail.map((row) => row.id)).not.toContain(heldRead?.id);
  }, 30_000);
});
