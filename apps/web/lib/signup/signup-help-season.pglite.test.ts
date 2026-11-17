import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { claimSignupHelpAttempt, signupHelpAttempted } from './signup-help-season';

const NOW = new Date('2026-09-29T15:00:00.000Z');
const SEASON = '2026-fall';
const NEXT = '2027-winter';

describe('claimSignupHelpAttempt', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb();
  });

  afterAll(async () => {
    await db.close();
  });

  it('counts up to the cap and refuses the extra increment', async () => {
    const { familyId } = await seedFamily(db.database);
    const first = await claimSignupHelpAttempt(db.database, {
      familyId,
      seasonKey: SEASON,
      cap: 2,
      now: NOW,
    });
    const second = await claimSignupHelpAttempt(db.database, {
      familyId,
      seasonKey: SEASON,
      cap: 2,
      now: NOW,
    });
    const third = await claimSignupHelpAttempt(db.database, {
      familyId,
      seasonKey: SEASON,
      cap: 2,
      now: NOW,
    });
    expect(first).toEqual({ ok: true, attempted: 1 });
    expect(second).toEqual({ ok: true, attempted: 2 });
    expect(third).toEqual({ ok: false, attempted: 2 });
    expect(await signupHelpAttempted(db.database, { familyId, seasonKey: SEASON })).toBe(2);
  });

  it('starts the next season at zero', async () => {
    const { familyId } = await seedFamily(db.database);
    await claimSignupHelpAttempt(db.database, {
      familyId,
      seasonKey: SEASON,
      cap: 2,
      now: NOW,
    });
    await claimSignupHelpAttempt(db.database, {
      familyId,
      seasonKey: SEASON,
      cap: 2,
      now: NOW,
    });
    expect(await signupHelpAttempted(db.database, { familyId, seasonKey: NEXT })).toBe(0);
    const next = await claimSignupHelpAttempt(db.database, {
      familyId,
      seasonKey: NEXT,
      cap: 2,
      now: NOW,
    });
    expect(next).toEqual({ ok: true, attempted: 1 });
    expect(await signupHelpAttempted(db.database, { familyId, seasonKey: SEASON })).toBe(2);
  });

  it('lets only one of two concurrent claims take the last slot', async () => {
    const { familyId } = await seedFamily(db.database);
    await claimSignupHelpAttempt(db.database, {
      familyId,
      seasonKey: SEASON,
      cap: 2,
      now: NOW,
    });
    const [a, b] = await Promise.all([
      claimSignupHelpAttempt(db.database, { familyId, seasonKey: SEASON, cap: 2, now: NOW }),
      claimSignupHelpAttempt(db.database, { familyId, seasonKey: SEASON, cap: 2, now: NOW }),
    ]);
    const ok = [a, b].filter((row) => row.ok);
    const refused = [a, b].filter((row) => !row.ok);
    expect(ok).toHaveLength(1);
    expect(ok[0]?.attempted).toBe(2);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.attempted).toBe(2);
    const [row] = await db.database
      .select({ attempted: schema.familySignupHelpSeasons.attempted })
      .from(schema.familySignupHelpSeasons)
      .where(eq(schema.familySignupHelpSeasons.familyId, familyId));
    expect(row?.attempted).toBe(2);
  });
});
