import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';
import { loadTextingByHour } from './texting-hours';

/**
 * The heatmap's substrate against real Postgres: Toronto-local day AND hour
 * (a 03:00Z message is 23:00 the previous Toronto day), inbound only, exact
 * counts per (day, hour) cell.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

function msg(
  familyId: string,
  parentUserId: string,
  direction: 'in' | 'out',
  createdAt: string,
) {
  return {
    familyId,
    parentUserId,
    channel: 'sms' as const,
    direction,
    category: 'reply' as const,
    status: 'delivered' as const,
    createdAt: new Date(createdAt),
  };
}

describe('loadTextingByHour', () => {
  it('returns nothing on an empty ledger (SQL parses + executes)', async () => {
    expect(await loadTextingByHour(db.database)).toEqual([]);
  });

  it('buckets by TORONTO day and hour, counts inbound only, exact cells', async () => {
    const fam = await seedFamily(db.database, 'Heatmap Family');

    await db.database.insert(schema.channelMessages).values([
      // 15:00Z on Aug 10 = Toronto 11:00 same day — two texts, one cell of 2.
      msg(fam.familyId, fam.parentUserId, 'in', '2026-08-10T15:00:00.000Z'),
      msg(fam.familyId, fam.parentUserId, 'in', '2026-08-10T15:40:00.000Z'),
      // 03:00Z on Aug 10 = Toronto Aug 9, 23:00 — the previous day's last hour.
      msg(fam.familyId, fam.parentUserId, 'in', '2026-08-10T03:00:00.000Z'),
      // Outbound never counts.
      msg(fam.familyId, fam.parentUserId, 'out', '2026-08-10T15:10:00.000Z'),
    ]);

    expect(await loadTextingByHour(db.database)).toEqual([
      { day: '2026-08-09', hour: 23, count: 1 },
      { day: '2026-08-10', hour: 11, count: 2 },
    ]);
  });
});
