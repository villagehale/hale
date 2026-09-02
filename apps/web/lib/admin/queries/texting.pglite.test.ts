import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';
import { loadTextingTrends } from './texting';

/**
 * The one aggregation-correctness test against real Postgres: the daily bucket
 * math (Toronto-local days, distinct senders, direction split) is SQL no fake
 * can stand in for — a UTC bucketing bug or a count(*) where count(distinct)
 * belongs would pass every mocked test and lie on the founder's ledger.
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
  status: 'delivered' | 'failed' = 'delivered',
) {
  return {
    familyId,
    parentUserId,
    channel: 'sms' as const,
    direction,
    category: 'reply' as const,
    status,
    createdAt: new Date(createdAt),
  };
}

describe('loadTextingTrends', () => {
  it('buckets by TORONTO day, counts senders DISTINCT, splits directions, counts failures', async () => {
    const a = await seedFamily(db.database, 'Family A');
    const b = await seedFamily(db.database, 'Family B');

    // Recent instants (inside the 365d window), pinned to known Toronto days:
    // 03:00Z on the 10th is 23:00 on the 9th in Toronto (EDT).
    const day9late = '2026-08-10T03:00:00.000Z'; // Toronto 2026-08-09 23:00
    const day10 = '2026-08-10T15:00:00.000Z'; // Toronto 2026-08-10 11:00

    await db.database.insert(schema.channelMessages).values([
      // Parent A texts twice on Toronto Aug 10 — ONE sender, TWO msgs in.
      msg(a.familyId, a.parentUserId, 'in', day10),
      msg(a.familyId, a.parentUserId, 'in', '2026-08-10T16:00:00.000Z'),
      // Parent B's 03:00Z message belongs to Toronto Aug 9, not Aug 10.
      msg(b.familyId, b.parentUserId, 'in', day9late),
      // THREE outbound on Aug 10, ONE failed — msgsOut counts all three sends,
      // msgsFailed counts the failure (the delivery-health numerator).
      msg(a.familyId, a.parentUserId, 'out', day10),
      msg(a.familyId, a.parentUserId, 'out', '2026-08-10T17:00:00.000Z'),
      msg(a.familyId, a.parentUserId, 'out', '2026-08-10T18:00:00.000Z', 'failed'),
      // An INBOUND failed row must never count toward msgsFailed — it is a
      // delivery-health numerator for sends, not a convention on inbound writers.
      msg(a.familyId, a.parentUserId, 'in', '2026-08-10T19:00:00.000Z', 'failed'),
    ]);

    const rows = await loadTextingTrends(db.database);
    const aug9 = rows.find((r) => r.day === '2026-08-09');
    const aug10 = rows.find((r) => r.day === '2026-08-10');

    expect(aug9).toEqual({ day: '2026-08-09', senders: 1, msgsIn: 1, msgsOut: 0, msgsFailed: 0 });
    expect(aug10).toEqual({ day: '2026-08-10', senders: 1, msgsIn: 3, msgsOut: 3, msgsFailed: 1 });
  });
});
