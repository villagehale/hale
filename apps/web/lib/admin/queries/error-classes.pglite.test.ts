import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';
import { loadErrorClasses } from './error-classes';

/**
 * The Operations landing's substrate against real Postgres: failed sends and
 * dead agent runs folded into day-grain classes — exact day arrays, exact
 * totals, privacy-clean labels (channel/agent + code only).
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('loadErrorClasses', () => {
  it('returns nothing on an empty ledger (both grouped queries parse)', async () => {
    expect(await loadErrorClasses(db.database)).toEqual([]);
  });

  it('folds failed sends across two Toronto days + a killed_cost run into exact classes', async () => {
    const fam = await seedFamily(db.database, 'Errors Family');

    await db.database.insert(schema.channelMessages).values(
      [
        // Two 21211 failures on Toronto Aug 10, one on Aug 9 (03:00Z boundary).
        { at: '2026-08-10T15:00:00.000Z', code: '21211' },
        { at: '2026-08-10T16:00:00.000Z', code: '21211' },
        { at: '2026-08-10T03:00:00.000Z', code: '21211' },
        // A delivered send never enters the ledger.
      ].map((row) => ({
        familyId: fam.familyId,
        parentUserId: fam.parentUserId,
        channel: 'sms' as const,
        direction: 'out' as const,
        category: 'reply' as const,
        status: 'failed' as const,
        errorCode: row.code,
        createdAt: new Date(row.at),
      })),
    );
    await db.database.insert(schema.channelMessages).values([
      {
        familyId: fam.familyId,
        parentUserId: fam.parentUserId,
        channel: 'sms' as const,
        direction: 'out' as const,
        category: 'reply' as const,
        status: 'delivered' as const,
        createdAt: new Date('2026-08-10T15:30:00.000Z'),
      },
    ]);

    await db.database.insert(schema.agentRuns).values([
      {
        familyId: fam.familyId,
        agentName: 'reviewer',
        modelUsed: 'claude-sonnet-5',
        status: 'killed_cost',
        startedAt: new Date('2026-08-10T15:00:00.000Z'),
      },
    ]);

    const classes = await loadErrorClasses(db.database);
    expect(classes).toEqual([
      {
        source: 'message',
        code: '21211',
        label: 'sms send failed',
        total: 3,
        lastAt: '2026-08-10T16:00:00Z',
        days: [
          { day: '2026-08-09', count: 1 },
          { day: '2026-08-10', count: 2 },
        ],
        sparkline: true,
      },
      {
        source: 'agent',
        code: 'killed_cost',
        label: 'reviewer',
        total: 1,
        lastAt: '2026-08-10T15:00:00Z',
        days: [{ day: '2026-08-10', count: 1 }],
        sparkline: true,
      },
    ]);
  });
});
