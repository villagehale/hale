import { schema } from '@hale/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import { claimIntakeTurn, completeIntakeTurn } from './turn-claim';

/**
 * The intake turn claim against the REAL DDL (migration 0106): the machine-level tests
 * ride the intake fake's model of the unique index, and a fake of an index can never
 * prove the index. This is the arbitration itself — first delivery wins, every later
 * one loses, completion stamps, retention sweeps — on real Postgres.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

const NOW = new Date('2026-09-03T12:00:00.000Z');

describe('claimIntakeTurn', () => {
  it('first delivery wins, every later delivery of the same sid loses', async () => {
    expect(await claimIntakeTurn(db.database, 'SM-claim-1', NOW)).toBe(true);
    expect(await claimIntakeTurn(db.database, 'SM-claim-1', NOW)).toBe(false);
    expect(await claimIntakeTurn(db.database, 'SM-claim-1', new Date(NOW.getTime() + 5_000))).toBe(
      false,
    );
    // Independent messages claim independently — the claim cannot fail closed.
    expect(await claimIntakeTurn(db.database, 'SM-claim-2', NOW)).toBe(true);
  });

  it('completion stamps the row; an unfinished claim is the visible residue', async () => {
    await claimIntakeTurn(db.database, 'SM-finished', NOW);
    await claimIntakeTurn(db.database, 'SM-crashed', NOW);
    await completeIntakeTurn(db.database, 'SM-finished', NOW);

    const rows = await db.database
      .select({
        providerMessageId: schema.smsIntakeTurnClaims.providerMessageId,
        completedAt: schema.smsIntakeTurnClaims.completedAt,
      })
      .from(schema.smsIntakeTurnClaims);
    const finished = rows.find((r) => r.providerMessageId === 'SM-finished');
    const crashed = rows.find((r) => r.providerMessageId === 'SM-crashed');
    expect(finished?.completedAt).toEqual(NOW);
    expect(crashed?.completedAt).toBeNull();
  });

  it('retention: a claim past its window is swept by the next claim, not resurrected', async () => {
    const old = new Date(NOW.getTime() - 25 * 3_600_000);
    await claimIntakeTurn(db.database, 'SM-ancient', old);

    // A later claim sweeps the aged row out...
    expect(await claimIntakeTurn(db.database, 'SM-today', NOW)).toBe(true);
    const swept = await db.database
      .select({ id: schema.smsIntakeTurnClaims.id })
      .from(schema.smsIntakeTurnClaims)
      .where(eq(schema.smsIntakeTurnClaims.providerMessageId, 'SM-ancient'));
    expect(swept).toHaveLength(0);
  });
});
