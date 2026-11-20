import { SONNET_MODEL } from '@hale/agent';
import { schema } from '@hale/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type TestDb, createTestDb } from '../testing/pglite.js';
import { insertSpend, pageAnthropicBillingError } from './anthropic-credit.js';

/**
 * Worker billing-error page. Real rate_limits claim; only fetch is stubbed.
 * Slack #ops only — never a parent text.
 */

const NOW = new Date('2026-11-16T10:30:00Z');
const CREDIT_ERR = {
  status: 400,
  error: {
    type: 'error',
    error: {
      type: 'billing_error',
      message: 'Your credit balance is too low to access the Anthropic API.',
    },
  },
};

let testDb: TestDb;
let fetchImpl: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  testDb = await createTestDb();
  vi.stubEnv('ANTHROPIC_CREDIT_ALERT_ENABLED', 'true');
  vi.stubEnv('OPS_SLACK_WEBHOOK_URL', 'https://hooks.slack.com/services/test');
  fetchImpl = vi.fn(async () => new Response('ok', { status: 200 }));
}, 120_000);

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await testDb.close();
});

describe('pageAnthropicBillingError', () => {
  it('pages #ops once per hour, never echoing the provider message', async () => {
    const first = await pageAnthropicBillingError(
      testDb.database,
      CREDIT_ERR,
      NOW,
      process.env,
      fetchImpl,
    );
    const second = await pageAnthropicBillingError(
      testDb.database,
      CREDIT_ERR,
      NOW,
      process.env,
      fetchImpl,
    );

    expect(first).toBe('paged');
    expect(second).toBe('deduped');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as { text: string };
    expect(body.text).toContain('HTTP 400, billing_error');
    expect(body.text).not.toContain('credit balance is too low');
    expect(body.text.toLowerCase()).not.toContain('sk-ant');
  });

  it('is flag_off when the flag is not exactly true', async () => {
    vi.stubEnv('ANTHROPIC_CREDIT_ALERT_ENABLED', 'TRUE');
    expect(
      await pageAnthropicBillingError(testDb.database, CREDIT_ERR, NOW, process.env, fetchImpl),
    ).toBe('flag_off');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('insertSpend', () => {
  it('writes a Claude row onto the prepaid ledger', async () => {
    await insertSpend(testDb.database, {
      model: SONNET_MODEL,
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      costUsd: 0.012345,
    });
    const rows = await testDb.database.select().from(schema.anthropicSpend);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.model).toBe(SONNET_MODEL);
    expect(rows[0]?.costUsd).toBe('0.012345');
  });
});
