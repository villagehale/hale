import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb, seedFamily } from '~/lib/testing/pglite';
import { defaultProviderHealthDeps } from './provider-health';
import { checkMonthlySpend } from './spend';

/**
 * VIL-552 · the monthly spend alert reaches Slack #ops. Real agent_runs sum, real
 * rate_limits claim, real postOpsSlack — only the network (fetch) is stubbed.
 */

const NOW = new Date('2026-10-31T10:27:00Z');
const THIS_MONTH = new Date('2026-10-15T12:00:00Z');
const LAST_MONTH = new Date('2026-09-20T12:00:00Z');

let testDb: TestDb;
let fetchImpl: ReturnType<typeof vi.fn>;

async function seedRuns(costs: Array<{ costUsd: string; startedAt: Date }>): Promise<void> {
  const family = await seedFamily(testDb.database, 'Spend Family');
  for (const run of costs) {
    await testDb.database.insert(schema.agentRuns).values({
      familyId: family.familyId,
      agentName: 'coach',
      modelUsed: 'test-model',
      costUsd: run.costUsd,
      startedAt: run.startedAt,
      status: 'completed',
    });
  }
}

beforeEach(async () => {
  testDb = await createTestDb();
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/test');
  vi.stubEnv('ANTHROPIC_SPEND_ALERT_USD', '50');
  fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchImpl);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await testDb.close();
});

describe('checkMonthlySpend', () => {
  it('pages #ops once at the threshold, counting this month only', async () => {
    await seedRuns([
      { costUsd: '30.000000', startedAt: THIS_MONTH },
      { costUsd: '20.000000', startedAt: THIS_MONTH },
      { costUsd: '500.000000', startedAt: LAST_MONTH },
    ]);

    const first = await checkMonthlySpend(testDb.database, defaultProviderHealthDeps(), NOW);
    const second = await checkMonthlySpend(testDb.database, defaultProviderHealthDeps(), NOW);

    expect(first).toEqual({ totalUsd: 50, threshold: 50, alert: 'paged' });
    expect(second).toEqual({ totalUsd: 50, threshold: 50, alert: 'deduped' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { text: string };
    expect(body.text).toContain('$50.00');
  });

  it('names a page Slack refused as page_not_delivered, not deduped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchImpl.mockImplementation(async () => new Response('no', { status: 500 }));
    await seedRuns([
      { costUsd: '30.000000', startedAt: THIS_MONTH },
      { costUsd: '20.000000', startedAt: THIS_MONTH },
    ]);

    const result = await checkMonthlySpend(testDb.database, defaultProviderHealthDeps(), NOW);

    expect(result).toEqual({ totalUsd: 50, threshold: 50, alert: 'page_not_delivered' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not page below the threshold', async () => {
    await seedRuns([
      { costUsd: '30.000000', startedAt: THIS_MONTH },
      { costUsd: '19.990000', startedAt: THIS_MONTH },
    ]);

    const result = await checkMonthlySpend(testDb.database, defaultProviderHealthDeps(), NOW);

    expect(result.alert).toBe('below_threshold');
    expect(result.totalUsd).toBeCloseTo(49.99, 6);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names an unset threshold instead of paging against a default', async () => {
    vi.stubEnv('ANTHROPIC_SPEND_ALERT_USD', undefined);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await seedRuns([{ costUsd: '500.000000', startedAt: THIS_MONTH }]);

    const result = await checkMonthlySpend(testDb.database, defaultProviderHealthDeps(), NOW);

    expect(result).toEqual({ totalUsd: 500, threshold: null, alert: 'threshold_not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().map(String).join(' ')).toContain('ANTHROPIC_SPEND_ALERT_USD');
  });
});
