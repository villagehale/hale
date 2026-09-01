import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, seedFamily, type TestDb } from '~/lib/testing/pglite';
import { loadAgentSpend } from './agent-spend';
import { loadAuditMix } from './audit-mix';
import { loadDbErrors } from './errors';
import { loadGrowth } from './growth';
import { loadIntakeFunnel } from './intake-funnel';
import { loadPulse } from './pulse';
import { loadRadar } from './radar';
import { loadTextingTrends } from './texting';

/**
 * Every admin loader runs against REAL Postgres (the migrated pglite schema).
 * The texting test proves the bucket math; this one proves the rest of the
 * SQL — percentile_cont, filter clauses, enum casts, make_interval — parses
 * and executes. A loader with a syntax error would render its panel's error
 * boundary forever while every mocked test stayed green.
 */

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

describe('admin loaders execute against real Postgres', () => {
  it('loadPulse: a full 24-slot band with zeroed counters', async () => {
    const pulse = await loadPulse(db.database);
    expect(pulse.hourly).toHaveLength(24);
    expect(pulse).toMatchObject({
      familiesToday: 0,
      msgsInToday: 0,
      msgsOutToday: 0,
      newFamiliesToday: 0,
      failuresToday: 0,
      spendTodayUsd: 0,
    });
  });

  it('loadGrowth: totals, tiers and days', async () => {
    expect(await loadGrowth(db.database)).toEqual({
      days: [],
      tiers: [],
      foundingCount: 0,
      total: 0,
    });
  });

  it('loadIntakeFunnel / loadAuditMix / loadTextingTrends: empty day sets', async () => {
    expect(await loadIntakeFunnel(db.database)).toEqual({ days: [], sources: [] });
    expect(await loadAuditMix(db.database)).toEqual([]);
    expect(await loadTextingTrends(db.database)).toEqual([]);
  });

  it('loadAgentSpend: days + byAgentDay (percentile_cont parses)', async () => {
    expect(await loadAgentSpend(db.database)).toEqual({ days: [], byAgentDay: [] });
  });

  it('loadRadar: upcoming, freshness, outcomes', async () => {
    expect(await loadRadar(db.database)).toEqual({
      upcoming: [],
      freshestVerifiedAt: null,
      lastVerifyRun: null,
      outcomes: [],
    });
  });

  it('loadDbErrors: merged empty ledger', async () => {
    expect(await loadDbErrors(db.database)).toEqual([]);
  });
});

describe('loadAgentSpend — day-grain leaderboard rows (seeded, exact)', () => {
  it('groups runs, failures and cost by Toronto day × agent', async () => {
    const fam = await seedFamily(db.database, 'Spend Family');
    const run = (
      agentName: 'reviewer' | 'drafter',
      startedAt: string,
      status: 'completed' | 'failed' | 'timed_out' | 'killed_cost' = 'completed',
      costUsd = '0.010000',
    ) => ({
      familyId: fam.familyId,
      agentName,
      modelUsed: 'claude-sonnet-5',
      status,
      costUsd,
      startedAt: new Date(startedAt),
    });

    await db.database.insert(schema.agentRuns).values([
      run('reviewer', '2026-08-10T15:00:00.000Z'),
      run('reviewer', '2026-08-10T16:00:00.000Z', 'failed', '0.020000'),
      // timed_out and killed_cost are failures too — the ONE failure
      // vocabulary, same as the Operations tab's classes.
      run('reviewer', '2026-08-10T17:00:00.000Z', 'timed_out', '0.005000'),
      // 03:00Z on Aug 11 is Toronto Aug 10, 23:00 — the boundary is Toronto's.
      run('drafter', '2026-08-11T03:00:00.000Z'),
      run('drafter', '2026-08-11T15:00:00.000Z'),
      run('drafter', '2026-08-11T16:00:00.000Z', 'killed_cost', '0.040000'),
    ]);

    const { days, byAgentDay } = await loadAgentSpend(db.database);
    expect(byAgentDay).toEqual([
      { day: '2026-08-10', agent: 'drafter', runs: 1, failedRuns: 0, costUsd: 0.01 },
      { day: '2026-08-10', agent: 'reviewer', runs: 3, failedRuns: 2, costUsd: 0.035 },
      { day: '2026-08-11', agent: 'drafter', runs: 2, failedRuns: 1, costUsd: 0.05 },
    ]);
    expect(days).toEqual([
      {
        day: '2026-08-10',
        costUsd: 0.045,
        runs: 4,
        failedRuns: 2,
        cacheHits: 0,
        cacheKnown: 0,
        p50LatencyMs: null,
      },
      {
        day: '2026-08-11',
        costUsd: 0.05,
        runs: 2,
        failedRuns: 1,
        cacheHits: 0,
        cacheKnown: 0,
        p50LatencyMs: null,
      },
    ]);
  });
});

describe('loadRadar — per-row verified stamp (seeded, exact)', () => {
  it('carries verifiedAt on every upcoming window', async () => {
    await db.database.insert(schema.registrationWindows).values([
      {
        municipality: 'toronto',
        programDomain: 'rec_program',
        cycleLabel: 'Winter 2027',
        openAt: new Date('2026-12-03T14:00:00.000Z'),
        residentOpenAt: new Date('2026-12-01T14:00:00.000Z'),
        sourceUrl: 'https://example.test/rec',
        verifiedAt: new Date('2026-08-20T12:00:00.000Z'),
      },
    ]);

    const radar = await loadRadar(db.database);
    expect(radar.upcoming).toEqual([
      {
        municipality: 'toronto',
        programDomain: 'rec_program',
        cycleLabel: 'Winter 2027',
        openAt: '2026-12-03T14:00:00Z',
        residentOpenAt: '2026-12-01T14:00:00Z',
        verifiedAt: '2026-08-20T12:00:00Z',
      },
    ]);
  });
});

describe('loadIntakeFunnel — day-grain sources (seeded, exact)', () => {
  it('groups starts and provisioned by Toronto day × code, coalescing null to direct', async () => {
    const fam = await seedFamily(db.database, 'Sources Family');
    const session = (
      phoneHash: string,
      createdAt: string,
      sourceCode: string | null,
      familyId: string | null = null,
    ) => ({
      phoneHash,
      phoneEncrypted: 'enc',
      state: 'awaiting_details',
      dataEncrypted: 'enc',
      sourceCode,
      familyId,
      createdAt: new Date(createdAt),
    });

    await db.database.insert(schema.smsIntakeSessions).values([
      // Toronto Aug 10: two earlyon starts, one provisioned; one direct (null code).
      session('h1', '2026-08-10T15:00:00.000Z', 'earlyon'),
      session('h2', '2026-08-10T16:00:00.000Z', 'earlyon', fam.familyId),
      session('h3', '2026-08-10T17:00:00.000Z', null),
      // 03:00Z on Aug 10 is Toronto Aug 9 — the day boundary is Toronto's.
      session('h4', '2026-08-10T03:00:00.000Z', 'earlyon'),
    ]);

    const { sources } = await loadIntakeFunnel(db.database);
    expect(sources).toEqual([
      { day: '2026-08-09', code: 'earlyon', started: 1, provisioned: 0 },
      { day: '2026-08-10', code: 'direct', started: 1, provisioned: 0 },
      { day: '2026-08-10', code: 'earlyon', started: 2, provisioned: 1 },
    ]);
  });
});

// Seeds "today" rows, so it must stay LAST — earlier describes assert on
// windows that would otherwise pick these up.
describe('loadPulse — failuresToday uses the one failure vocabulary (seeded, exact)', () => {
  it('counts failed, timed_out and killed_cost runs; completed never', async () => {
    const fam = await seedFamily(db.database, 'Pulse Family');
    const run = (status: 'completed' | 'failed' | 'timed_out' | 'killed_cost') => ({
      familyId: fam.familyId,
      agentName: 'reviewer' as const,
      modelUsed: 'claude-sonnet-5',
      status,
      costUsd: '0.010000',
      startedAt: new Date(),
    });

    await db.database
      .insert(schema.agentRuns)
      .values([run('completed'), run('failed'), run('timed_out'), run('killed_cost')]);

    const pulse = await loadPulse(db.database);
    expect(pulse.failuresToday).toBe(3);
  });
});
