import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
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

  it('loadAgentSpend: days + byAgent (percentile_cont parses)', async () => {
    expect(await loadAgentSpend(db.database)).toEqual({ days: [], byAgent: [] });
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
