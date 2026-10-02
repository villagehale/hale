import { schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { deliverSameActivityReply } from './copy';
import { SAME_ACTIVITY_MEET_ENABLED_ENV } from './flag';
import { answerSameActivity, prepareSameActivityOffer } from './offer';

const KEY = 'pool.example|saturday-swim|2026-10-01T15:00:00.000Z';
const OTHER_KEY = 'library.example|storytime|2026-10-02T15:00:00.000Z';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

beforeEach(async () => {
  vi.stubEnv(SAME_ACTIVITY_MEET_ENABLED_ENV, 'true');
  await db.exec(
    'truncate table same_activity_opt_ins, audit_log, family_members, users, families cascade',
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function watchQueries(): { sql: string[]; rows: unknown[][]; restore: () => void } {
  const sql: string[] = [];
  const rows: unknown[][] = [];
  const real = db.client.query.bind(db.client);
  const record = async (text: string, params?: unknown[], options?: unknown) => {
    const result = await real(text, params as never, options as never);
    if (text.includes('same_activity_opt_ins')) {
      sql.push(text);
      rows.push(result.rows);
    }
    return result;
  };
  const spy = vi.spyOn(db.client, 'query').mockImplementation(record as typeof db.client.query);
  return {
    sql,
    rows,
    restore: () => spy.mockRestore(),
  };
}

describe('same-activity offer', () => {
  it('does not read or write while the flag is off', async () => {
    vi.stubEnv(SAME_ACTIVITY_MEET_ENABLED_ENV, 'true\n');
    const family = await seedFamily(db.database, 'Dark Family');
    const seen = watchQueries();
    const prepared = await prepareSameActivityOffer(db.database, {
      familyId: family.familyId,
      activityKey: KEY,
      kind: 'meet',
    });
    const answered = await answerSameActivity(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      activityKey: KEY,
      messageId: 'm-1',
      body: 'meet',
    });
    seen.restore();

    expect(prepared).toEqual({ status: 'skipped', reason: 'flag_off' });
    expect(answered).toEqual({ status: 'skipped', reason: 'flag_off' });
    expect(seen.sql).toEqual([]);
    const stored = await db.database.select().from(schema.sameActivityOptIns);
    expect(stored).toEqual([]);
  });

  it('hides a household that opted in from one that has not', async () => {
    const asked = await seedFamily(db.database, 'Asked Family');
    const opted = await seedFamily(db.database, 'Opted Family');
    await answerSameActivity(db.database, {
      familyId: opted.familyId,
      parentUserId: opted.parentUserId,
      activityKey: KEY,
      messageId: 'm-opted',
      body: 'meet',
    });
    const [optIn] = await db.database
      .select({ id: schema.sameActivityOptIns.id })
      .from(schema.sameActivityOptIns);
    expect(optIn?.id).toBeTruthy();

    const seen = watchQueries();
    const prepared = await prepareSameActivityOffer(db.database, {
      familyId: asked.familyId,
      activityKey: KEY,
      kind: 'meet',
    });
    seen.restore();

    expect(prepared.status).toBe('not_opted_in');
    if (prepared.status !== 'not_opted_in') throw new Error('expected not_opted_in');
    expect(prepared).not.toHaveProperty('counterpartFamilyIds');
    expect(JSON.stringify(prepared)).not.toContain(opted.familyId);
    expect(prepared.reply.text).not.toContain('pool.example');
    expect(prepared.reply.text).not.toContain('saturday');
    const returned = JSON.stringify(seen.rows);
    expect(returned).not.toContain(optIn?.id ?? 'missing-opt-in');
    expect(returned).not.toContain(opted.familyId);
    expect(seen.sql.length).toBeGreaterThan(0);
    expect(seen.sql.some((text) => text.includes('activity_bookings'))).toBe(false);
    expect(seen.sql.some((text) => text.includes('children'))).toBe(false);
  });

  it('offers a meet only after both households opt in, and still does not send the line', async () => {
    const a = await seedFamily(db.database, 'Family A');
    const b = await seedFamily(db.database, 'Family B');
    const bookedOnly = await seedFamily(db.database, 'Booked Only');

    const first = await answerSameActivity(db.database, {
      familyId: a.familyId,
      parentUserId: a.parentUserId,
      activityKey: KEY,
      messageId: 'm-a',
      body: 'Meet.',
    });
    expect(first).toMatchObject({ status: 'waiting', recorded: 'created' });
    expect(first).not.toHaveProperty('counterpartFamilyIds');
    expect(JSON.stringify(first)).not.toContain(b.familyId);
    expect(JSON.stringify(first)).not.toContain(bookedOnly.familyId);

    const second = await answerSameActivity(db.database, {
      familyId: b.familyId,
      parentUserId: b.parentUserId,
      activityKey: KEY,
      messageId: 'm-b',
      body: 'meet',
    });
    expect(second).toMatchObject({
      status: 'mutual',
      recorded: 'created',
      kind: 'meet',
      counterpartFamilyIds: [a.familyId],
    });
    if (second.status !== 'mutual') throw new Error('expected a mutual meet');
    expect(second.reply.text).not.toContain(a.familyId);
    expect(second.reply.text).not.toContain(b.familyId);
    expect(second.reply.text).not.toContain('pool.example');
    expect(second.reply.text).not.toContain('saturday');
    expect(second.reply.mayLeave).toBe(false);
    expect(second.reply.text.endsWith(second.reply.nextStep)).toBe(true);
    expect(deliverSameActivityReply(second.reply.text)).toEqual({
      sent: false,
      skipped: 'placeholder',
    });

    const back = await prepareSameActivityOffer(db.database, {
      familyId: a.familyId,
      activityKey: KEY,
      kind: 'meet',
    });
    expect(back).toMatchObject({
      status: 'mutual',
      counterpartFamilyIds: [b.familyId],
    });
    expect(JSON.stringify(back)).not.toContain(bookedOnly.familyId);

    const again = await answerSameActivity(db.database, {
      familyId: a.familyId,
      parentUserId: a.parentUserId,
      activityKey: KEY,
      messageId: 'm-a-2',
      body: 'meet',
    });
    expect(again).toMatchObject({ status: 'mutual', recorded: 'already' });
    const rows = await db.database.select().from(schema.sameActivityOptIns);
    expect(rows).toHaveLength(2);
  });

  it('does not treat a different activity or a different kind as mutual', async () => {
    const a = await seedFamily(db.database, 'Kind A');
    const b = await seedFamily(db.database, 'Kind B');
    await answerSameActivity(db.database, {
      familyId: a.familyId,
      parentUserId: a.parentUserId,
      activityKey: KEY,
      messageId: 'm-meet',
      body: 'meet',
    });
    const joined = await answerSameActivity(db.database, {
      familyId: b.familyId,
      parentUserId: b.parentUserId,
      activityKey: KEY,
      messageId: 'm-join',
      body: 'join',
    });
    expect(joined.status).toBe('waiting');
    expect(joined).not.toHaveProperty('counterpartFamilyIds');
    expect(JSON.stringify(joined)).not.toContain(a.familyId);

    const elsewhere = await answerSameActivity(db.database, {
      familyId: b.familyId,
      parentUserId: b.parentUserId,
      activityKey: OTHER_KEY,
      messageId: 'm-other',
      body: 'meet',
    });
    expect(elsewhere).toMatchObject({ status: 'waiting' });
    expect(JSON.stringify(elsewhere)).not.toContain(a.familyId);
  });

  it('withdraws on no, including after the flag is off, and stops the match', async () => {
    const a = await seedFamily(db.database, 'Withdraw A');
    const b = await seedFamily(db.database, 'Withdraw B');
    await answerSameActivity(db.database, {
      familyId: a.familyId,
      parentUserId: a.parentUserId,
      activityKey: KEY,
      messageId: 'm-a',
      body: 'join',
    });
    await answerSameActivity(db.database, {
      familyId: b.familyId,
      parentUserId: b.parentUserId,
      activityKey: KEY,
      messageId: 'm-b',
      body: 'join',
    });

    vi.stubEnv(SAME_ACTIVITY_MEET_ENABLED_ENV, '');
    const declined = await answerSameActivity(db.database, {
      familyId: a.familyId,
      parentUserId: a.parentUserId,
      activityKey: KEY,
      messageId: 'm-no',
      body: 'no',
    });
    expect(declined).toMatchObject({ status: 'declined', recorded: 'revoked' });
    if (declined.status !== 'declined') throw new Error('expected a decline');
    expect(declined.reply.text.endsWith(declined.reply.nextStep)).toBe(true);
    expect(declined.reply.text).not.toMatch(/\bSTOP\b/);
    expect(deliverSameActivityReply(declined.reply.text).skipped).toBe('placeholder');

    vi.stubEnv(SAME_ACTIVITY_MEET_ENABLED_ENV, 'true');
    const remaining = await prepareSameActivityOffer(db.database, {
      familyId: b.familyId,
      activityKey: KEY,
      kind: 'join_group',
    });
    expect(remaining).toEqual(expect.objectContaining({ status: 'waiting' }));
    expect(remaining).not.toHaveProperty('counterpartFamilyIds');
    expect(JSON.stringify(remaining)).not.toContain(a.familyId);

    const audits = await db.database
      .select({
        actionTaken: schema.auditLog.actionTaken,
        after: schema.auditLog.after,
      })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.familyId, a.familyId),
          eq(schema.auditLog.actionTaken, 'same_activity_opt_in_recorded'),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]?.after)).not.toContain(b.familyId);
  });

  it('refuses an address-shaped key and does not claim STOP', async () => {
    const family = await seedFamily(db.database, 'Refused Family');
    const refused = await answerSameActivity(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      activityKey: 'parent@example.com',
      messageId: 'm-bad',
      body: 'meet',
    });
    expect(refused).toEqual({ status: 'refused', reason: 'invalid_activity' });

    const unread = await answerSameActivity(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      activityKey: KEY,
      messageId: 'm-stop',
      body: 'STOP',
    });
    expect(unread).toMatchObject({ status: 'unread' });
    const stored = await db.database.select().from(schema.sameActivityOptIns);
    expect(stored).toEqual([]);
  });

  it('enables RLS and removes the yes when the household is deleted', async () => {
    const family = await seedFamily(db.database, 'Erased Family');
    await answerSameActivity(db.database, {
      familyId: family.familyId,
      parentUserId: family.parentUserId,
      activityKey: KEY,
      messageId: 'm-1',
      body: 'meet',
    });
    const rls = (await db.database.execute(
      sql`select relrowsecurity from pg_class where relname = 'same_activity_opt_ins'`,
    )) as unknown as { rows: Array<{ relrowsecurity: boolean }> };
    expect(rls.rows[0]?.relrowsecurity).toBe(true);

    await db.database.delete(schema.families).where(eq(schema.families.id, family.familyId));
    const left = await db.database.select().from(schema.sameActivityOptIns);
    expect(left).toEqual([]);
  });
});
