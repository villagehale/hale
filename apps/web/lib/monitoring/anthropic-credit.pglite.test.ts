import { SONNET_MODEL } from '@hale/agent';
import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';
import {
  checkAnthropicCredit,
  pageAnthropicBillingError,
  recordAnthropicSpend,
} from './anthropic-credit';

/**
 * Prepaid Anthropic credit remaining. Real anthropic_spend sum, real rate_limits
 * claim, real postOpsSlack — only the network (fetch) is stubbed. Slack #ops only.
 */

const NOW = new Date('2026-11-16T10:30:00Z');
const START_AT = new Date('2026-11-01T00:00:00.000Z');
const IN_WINDOW = new Date('2026-11-16T08:00:00Z');
const BEFORE_WINDOW = new Date('2026-11-14T08:00:00Z');

const CREDIT_ERR = {
  status: 400,
  error: {
    type: 'error',
    error: {
      type: 'invalid_request_error',
      message:
        'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    },
  },
};

let testDb: TestDb;
let fetchImpl: ReturnType<typeof vi.fn>;

async function seedSpend(costUsd: string, occurredAt: Date): Promise<void> {
  await recordAnthropicSpend(
    testDb.database,
    {
      model: SONNET_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: Number(costUsd),
    },
    occurredAt,
  );
}

function enableCredit(over: Record<string, string> = {}): void {
  vi.stubEnv('ANTHROPIC_CREDIT_ALERT_ENABLED', 'true');
  vi.stubEnv('ANTHROPIC_CREDIT_START_USD', '200');
  vi.stubEnv('ANTHROPIC_CREDIT_START_AT', START_AT.toISOString());
  for (const [key, value] of Object.entries(over)) vi.stubEnv(key, value);
}

beforeEach(async () => {
  testDb = await createTestDb();
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/test');
  fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
  vi.stubGlobal('fetch', fetchImpl);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await testDb.close();
});

describe('checkAnthropicCredit', () => {
  it('names flag_off without paging when the flag is not exactly true', async () => {
    vi.stubEnv('ANTHROPIC_CREDIT_ALERT_ENABLED', 'true\n');
    await seedSpend('190.000000', IN_WINDOW);

    const result = await checkAnthropicCredit(testDb.database, undefined, NOW);

    expect(result.alert).toBe('flag_off');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('names start_not_configured when the start env is missing', async () => {
    vi.stubEnv('ANTHROPIC_CREDIT_ALERT_ENABLED', 'true');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    const result = await checkAnthropicCredit(testDb.database, undefined, NOW);

    expect(result.alert).toBe('start_not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(errors.mock.calls.flat().map(String).join(' ')).toContain('ANTHROPIC_CREDIT_START_USD');
  });

  it('does not page while remaining is at or above the first threshold', async () => {
    enableCredit();
    await seedSpend('160.000000', IN_WINDOW);

    const result = await checkAnthropicCredit(testDb.database, undefined, NOW);

    expect(result.alert).toBe('below_threshold');
    expect(result.remainingUsd).toBeCloseTo(40, 6);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('pages #ops once below $40, then once below $15, per start value', async () => {
    enableCredit();
    await seedSpend('10.000000', BEFORE_WINDOW);
    await seedSpend('155.000000', IN_WINDOW);

    const first = await checkAnthropicCredit(testDb.database, undefined, NOW);
    const second = await checkAnthropicCredit(testDb.database, undefined, NOW);

    expect(first.alert).toBe('paged');
    expect(first.paged).toEqual([40]);
    expect(first.remainingUsd).toBeCloseTo(35, 6);
    expect(first.spendLast24hUsd).toBeCloseTo(155, 6);
    expect(first.daysLeft).toBeCloseTo(35 / 155, 6);
    expect(second.alert).toBe('deduped');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { text: string };
    expect(body.text).toContain('remaining $35.00 (below $40.00)');
    expect(body.text).toContain('spend last 24h: $155.00');
    expect(body.text).toContain('Switch the Prod ANTHROPIC_API_KEY');
    expect(body.text.toLowerCase()).not.toContain('sk-ant');

    await seedSpend('25.000000', IN_WINDOW);
    const third = await checkAnthropicCredit(testDb.database, undefined, NOW);
    expect(third.alert).toBe('paged');
    expect(third.paged).toEqual([15]);
    expect(third.remainingUsd).toBeCloseTo(10, 6);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    const fourth = await checkAnthropicCredit(testDb.database, undefined, NOW);
    expect(fourth.alert).toBe('deduped');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('pages both thresholds on a jump from well-funded to nearly empty, higher first', async () => {
    enableCredit();
    await seedSpend('190.000000', IN_WINDOW);

    const result = await checkAnthropicCredit(testDb.database, undefined, NOW);

    expect(result.alert).toBe('paged');
    expect(result.paged).toEqual([40, 15]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const first = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { text: string };
    const second = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as { text: string };
    expect(first.text).toContain('below $40.00');
    expect(second.text).toContain('below $15.00');
  });

  it('releases the claim when Slack refuses so the next tick retries', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    enableCredit();
    fetchImpl.mockImplementation(async () => new Response('no', { status: 500 }));
    await seedSpend('165.000000', IN_WINDOW);

    const failed = await checkAnthropicCredit(testDb.database, undefined, NOW);
    expect(failed.alert).toBe('page_not_delivered');
    expect(failed.paged).toEqual([]);

    fetchImpl.mockImplementation(async () => new Response('ok', { status: 200 }));
    const retried = await checkAnthropicCredit(testDb.database, undefined, NOW);
    expect(retried.alert).toBe('paged');
    expect(retried.paged).toEqual([40]);
  });

  it('a new start value can page again', async () => {
    enableCredit();
    await seedSpend('165.000000', IN_WINDOW);
    expect((await checkAnthropicCredit(testDb.database, undefined, NOW)).alert).toBe('paged');

    vi.stubEnv('ANTHROPIC_CREDIT_START_AT', '2026-11-16T00:00:00.000Z');
    const again = await checkAnthropicCredit(testDb.database, undefined, NOW);
    expect(again.alert).toBe('paged');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('pages one expiry warning each on Nov 28 and Dec 2, once per expiry value', async () => {
    enableCredit({ ANTHROPIC_CREDIT_EXPIRES_AT: '2026-12-05T00:00:00.000Z' });
    await seedSpend('20.000000', IN_WINDOW);
    const before = new Date('2026-11-28T14:59:59.000Z');
    const sevenDay = new Date('2026-11-28T15:00:00.000Z');
    const threeDay = new Date('2026-12-02T15:00:00.000Z');

    expect((await checkAnthropicCredit(testDb.database, undefined, before)).alert).toBe(
      'below_threshold',
    );
    expect(fetchImpl).not.toHaveBeenCalled();

    const first = await checkAnthropicCredit(testDb.database, undefined, sevenDay);
    expect(first.alert).toBe('paged');
    expect(first.expiryPaged).toEqual([7]);
    expect(first.paged).toEqual([]);
    expect(first.remainingUsd).toBeCloseTo(180, 6);
    const sevenBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { text: string };
    expect(sevenBody.text).toContain('expires 2026-12-05T00:00:00.000Z (7-day warning)');
    expect(sevenBody.text).toContain('remaining: $180.00');
    expect(sevenBody.text).toContain('Switch Prod to a paid ANTHROPIC_API_KEY before expiry');
    expect(sevenBody.text.toLowerCase()).not.toContain('sk-ant');

    const again = await checkAnthropicCredit(testDb.database, undefined, sevenDay);
    expect(again.alert).toBe('deduped');
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const second = await checkAnthropicCredit(testDb.database, undefined, threeDay);
    expect(second.alert).toBe('paged');
    expect(second.expiryPaged).toEqual([3]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const threeBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body)) as { text: string };
    expect(threeBody.text).toContain('expires 2026-12-05T00:00:00.000Z (3-day warning)');

    const third = await checkAnthropicCredit(testDb.database, undefined, threeDay);
    expect(third.alert).toBe('deduped');
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    vi.stubEnv('ANTHROPIC_CREDIT_EXPIRES_AT', '2026-12-06T00:00:00.000Z');
    const catchUp = new Date('2026-12-03T15:00:00.000Z');
    const rotated = await checkAnthropicCredit(testDb.database, undefined, catchUp);
    expect(rotated.alert).toBe('paged');
    expect(rotated.expiryPaged).toEqual([7, 3]);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('releases the expiry claim when Slack refuses so the next tick retries', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    enableCredit({ ANTHROPIC_CREDIT_EXPIRES_AT: '2026-12-05T00:00:00.000Z' });
    fetchImpl.mockImplementation(async () => new Response('no', { status: 500 }));
    const sevenDay = new Date('2026-11-28T15:00:00.000Z');

    const failed = await checkAnthropicCredit(testDb.database, undefined, sevenDay);
    expect(failed.alert).toBe('page_not_delivered');
    expect(failed.expiryPaged).toEqual([]);

    fetchImpl.mockImplementation(async () => new Response('ok', { status: 200 }));
    const retried = await checkAnthropicCredit(testDb.database, undefined, sevenDay);
    expect(retried.alert).toBe('paged');
    expect(retried.expiryPaged).toEqual([7]);
  });
});

describe('pageAnthropicBillingError', () => {
  it('pages #ops once per hour on a credit-balance 400', async () => {
    enableCredit();

    const first = await pageAnthropicBillingError(testDb.database, CREDIT_ERR, undefined, NOW);
    const second = await pageAnthropicBillingError(testDb.database, CREDIT_ERR, undefined, NOW);
    const nextHour = await pageAnthropicBillingError(
      testDb.database,
      CREDIT_ERR,
      undefined,
      new Date('2026-11-16T11:00:00Z'),
    );

    expect(first).toBe('paged');
    expect(second).toBe('deduped');
    expect(nextHour).toBe('paged');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { text: string };
    expect(body.text).toContain('HTTP 400, invalid_request_error');
    expect(body.text).not.toContain('credit balance is too low');
    expect(body.text.toLowerCase()).not.toContain('sk-ant');
  });

  it('does not page a usage-limit 400 or when the flag is off', async () => {
    enableCredit();
    const usageLimit = {
      status: 400,
      error: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message:
            'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
        },
      },
    };
    expect(await pageAnthropicBillingError(testDb.database, usageLimit, undefined, NOW)).toBe(
      'not_credit_error',
    );

    vi.stubEnv('ANTHROPIC_CREDIT_ALERT_ENABLED', 'false');
    expect(await pageAnthropicBillingError(testDb.database, CREDIT_ERR, undefined, NOW)).toBe(
      'flag_off',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('releases the hourly claim when Slack refuses', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    enableCredit();
    fetchImpl.mockImplementation(async () => new Response('no', { status: 500 }));

    expect(await pageAnthropicBillingError(testDb.database, CREDIT_ERR, undefined, NOW)).toBe(
      'page_not_delivered',
    );

    fetchImpl.mockImplementation(async () => new Response('ok', { status: 200 }));
    expect(await pageAnthropicBillingError(testDb.database, CREDIT_ERR, undefined, NOW)).toBe(
      'paged',
    );
  });
});

describe('recordAnthropicSpend', () => {
  it('writes a ledger row the remaining check can sum', async () => {
    enableCredit();
    await seedSpend('5.250000', IN_WINDOW);
    const rows = await testDb.database.select().from(schema.anthropicSpend);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.costUsd).toBe('5.250000');
    const result = await checkAnthropicCredit(testDb.database, undefined, NOW);
    expect(result.spendUsd).toBeCloseTo(5.25, 6);
    expect(result.remainingUsd).toBeCloseTo(194.75, 6);
  });
});
