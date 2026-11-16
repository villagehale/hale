import { describe, expect, it } from 'vitest';
import { estimateCostUsd } from './cost.js';
import {
  CREDIT_ALERT_USD_DEFAULT,
  CREDIT_CRITICAL_USD,
  CREDIT_EXPIRY_WARN_DAYS_DEFAULT,
  anthropicCreditAlertEnabled,
  creditAlertThresholds,
  creditErrorShape,
  creditRemainingUsd,
  crossedCreditThresholds,
  daysLeftEstimate,
  dueExpiryWarnings,
  expiryWarningFireAt,
  formatCreditBillingErrorAlert,
  formatCreditExpiryAlert,
  formatCreditRemainingAlert,
  isAnthropicCreditError,
  parseExpiryWarnDays,
  readCreditConfig,
  spendRowFromUsage,
} from './credit-alert.js';
import { SONNET_MODEL } from './model.js';

function apiError(status: number, type: string, message: string, extra?: { errorType?: string }) {
  return {
    status,
    error: {
      type: 'error',
      error: { type: extra?.errorType ?? type, message },
    },
    message: `400 ${message}`,
  };
}

describe('anthropicCreditAlertEnabled', () => {
  it('is on only for exactly true, untrimmed', () => {
    expect(anthropicCreditAlertEnabled({})).toBe(false);
    expect(anthropicCreditAlertEnabled({ ANTHROPIC_CREDIT_ALERT_ENABLED: 'true' })).toBe(true);
    expect(anthropicCreditAlertEnabled({ ANTHROPIC_CREDIT_ALERT_ENABLED: 'true\n' })).toBe(false);
    expect(anthropicCreditAlertEnabled({ ANTHROPIC_CREDIT_ALERT_ENABLED: 'TRUE' })).toBe(false);
    expect(anthropicCreditAlertEnabled({ ANTHROPIC_CREDIT_ALERT_ENABLED: ' true ' })).toBe(false);
  });
});

describe('readCreditConfig', () => {
  const start = {
    ANTHROPIC_CREDIT_START_USD: '200',
    ANTHROPIC_CREDIT_START_AT: '2026-11-01T00:00:00.000Z',
  };

  it('requires a positive start amount and a parseable start instant', () => {
    expect(readCreditConfig({})).toEqual({ ok: false, reason: 'start_not_configured' });
    expect(readCreditConfig({ ANTHROPIC_CREDIT_START_USD: '200' })).toEqual({
      ok: false,
      reason: 'start_not_configured',
    });
    expect(
      readCreditConfig({ ANTHROPIC_CREDIT_START_AT: start.ANTHROPIC_CREDIT_START_AT }),
    ).toEqual({ ok: false, reason: 'start_not_configured' });
    expect(readCreditConfig({ ...start, ANTHROPIC_CREDIT_START_USD: '0' })).toEqual({
      ok: false,
      reason: 'start_not_configured',
    });
  });

  it('defaults the first alert to 40 and honours a positive override', () => {
    const parsed = readCreditConfig(start);
    expect(parsed).toMatchObject({
      ok: true,
      config: { startUsd: 200, alertUsd: CREDIT_ALERT_USD_DEFAULT },
    });
    if (parsed.ok) {
      expect(parsed.config.startAt.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    }
    expect(readCreditConfig({ ...start, ANTHROPIC_CREDIT_ALERT_USD: '25' })).toMatchObject({
      ok: true,
      config: { alertUsd: 25 },
    });
  });

  it('treats expiry as optional and defaults warn days to 7 then 3', () => {
    const parsed = readCreditConfig(start);
    expect(parsed).toMatchObject({
      ok: true,
      config: { expiresAt: null, warnDays: [...CREDIT_EXPIRY_WARN_DAYS_DEFAULT] },
    });
    const withExpiry = readCreditConfig({
      ...start,
      ANTHROPIC_CREDIT_EXPIRES_AT: '2026-12-05T00:00:00.000Z',
      ANTHROPIC_CREDIT_EXPIRY_WARN_DAYS: '5,1',
    });
    expect(withExpiry).toMatchObject({ ok: true, config: { warnDays: [5, 1] } });
    if (withExpiry.ok) {
      expect(withExpiry.config.expiresAt?.toISOString()).toBe('2026-12-05T00:00:00.000Z');
    }
  });
});

describe('parseExpiryWarnDays', () => {
  it('defaults, dedupes, and sorts descending', () => {
    expect(parseExpiryWarnDays(undefined)).toEqual([7, 3]);
    expect(parseExpiryWarnDays('')).toEqual([7, 3]);
    expect(parseExpiryWarnDays('0')).toEqual([7, 3]);
    expect(parseExpiryWarnDays('3,7,7')).toEqual([7, 3]);
    expect(parseExpiryWarnDays('5 1')).toEqual([5, 1]);
  });
});

describe('expiry warnings', () => {
  const expiresAt = new Date('2026-12-05T00:00:00.000Z');

  it('fires mid-morning ET on Nov 28 and Dec 2 for a Dec 5 UTC expiry', () => {
    expect(expiryWarningFireAt(expiresAt, 7).toISOString()).toBe('2026-11-28T15:00:00.000Z');
    expect(expiryWarningFireAt(expiresAt, 3).toISOString()).toBe('2026-12-02T15:00:00.000Z');
  });

  it('is due at 10:00 ET, catch-up until expiry, and skips after expiry', () => {
    const warnDays = [7, 3];
    expect(
      dueExpiryWarnings(expiresAt, warnDays, new Date('2026-11-28T14:59:59.000Z'), new Set()),
    ).toEqual([]);
    expect(
      dueExpiryWarnings(expiresAt, warnDays, new Date('2026-11-28T15:00:00.000Z'), new Set()),
    ).toEqual([7]);
    expect(
      dueExpiryWarnings(expiresAt, warnDays, new Date('2026-11-29T16:00:00.000Z'), new Set()),
    ).toEqual([7]);
    expect(
      dueExpiryWarnings(expiresAt, warnDays, new Date('2026-12-02T15:00:00.000Z'), new Set()),
    ).toEqual([7, 3]);
    expect(
      dueExpiryWarnings(expiresAt, warnDays, new Date('2026-12-02T15:00:00.000Z'), new Set([7])),
    ).toEqual([3]);
    expect(
      dueExpiryWarnings(expiresAt, warnDays, new Date('2026-12-05T00:00:00.000Z'), new Set()),
    ).toEqual([]);
    expect(
      dueExpiryWarnings(null, warnDays, new Date('2026-12-02T15:00:00.000Z'), new Set()),
    ).toEqual([]);
  });
});

describe('formatCreditExpiryAlert', () => {
  it('is fixed ops text: expiry date, remaining dollars, switch to a paid key', () => {
    const text = formatCreditExpiryAlert({
      remainingUsd: 87.4,
      expiresAt: new Date('2026-12-05T00:00:00.000Z'),
      daysBefore: 7,
    });
    expect(text).toContain('expires 2026-12-05T00:00:00.000Z (7-day warning)');
    expect(text).toContain('remaining: $87.40');
    expect(text).toContain('Switch Prod to a paid ANTHROPIC_API_KEY before expiry');
    expect(text.toLowerCase()).not.toContain('sk-ant');
  });
});

describe('cost math', () => {
  it('prices a cached Sonnet call from the one rate table and subtracts it from start', () => {
    // Same turn as cost.test.ts: 200 in + 1024 cache-write + 5303 cache-read + 90 out.
    const usage = {
      input_tokens: 200,
      cache_creation_input_tokens: 1024,
      cache_read_input_tokens: 5303,
      output_tokens: 90,
    };
    const row = spendRowFromUsage(SONNET_MODEL, usage);
    expect(row).not.toBeNull();
    expect(row?.costUsd).toBeCloseTo(
      estimateCostUsd(SONNET_MODEL, {
        inputTokens: 200,
        cacheCreationTokens: 1024,
        cacheReadTokens: 5303,
        outputTokens: 90,
      }),
      9,
    );
    expect(creditRemainingUsd(200, row?.costUsd ?? 0)).toBeCloseTo(200 - (row?.costUsd ?? 0), 9);
  });

  it('does not book DeepSeek or a missing usage against prepaid Anthropic credit', () => {
    expect(spendRowFromUsage('deepseek/deepseek-v4.1-flash', { input_tokens: 1000 })).toBeNull();
    expect(spendRowFromUsage(SONNET_MODEL, null)).toBeNull();
  });

  it('records an unlisted Claude id at $0 rather than inventing a rate', () => {
    const row = spendRowFromUsage('claude-unknown-9', {
      input_tokens: 1_000_000,
      output_tokens: 1,
    });
    expect(row).toEqual({
      model: 'claude-unknown-9',
      inputTokens: 1_000_000,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    });
  });
});

describe('thresholds', () => {
  it('posts at the configured first line and again at 15, higher first', () => {
    expect(creditAlertThresholds(40)).toEqual([40, CREDIT_CRITICAL_USD]);
    expect(creditAlertThresholds(15)).toEqual([15]);
    expect(creditAlertThresholds(10)).toEqual([15, 10]);
  });

  it('names each newly crossed threshold once per start value', () => {
    expect(crossedCreditThresholds(50, [40, 15], new Set())).toEqual([]);
    expect(crossedCreditThresholds(39.99, [40, 15], new Set())).toEqual([40]);
    expect(crossedCreditThresholds(8, [40, 15], new Set())).toEqual([40, 15]);
    expect(crossedCreditThresholds(8, [40, 15], new Set([40]))).toEqual([15]);
    expect(crossedCreditThresholds(8, [40, 15], new Set([40, 15]))).toEqual([]);
  });
});

describe('daysLeftEstimate', () => {
  it('divides remaining by the per-day rate over the measured window', () => {
    // $10 in 24h, $40 left → 4 days.
    expect(daysLeftEstimate(40, 10, 86_400_000)).toBeCloseTo(4, 6);
    // $2 in 2h is $24/day, $48 left → 2 days. A raw 24h reading of $2 would overstate.
    expect(daysLeftEstimate(48, 2, 2 * 3_600_000)).toBeCloseTo(2, 6);
  });

  it('is null when nothing spent, and floors at zero remaining', () => {
    expect(daysLeftEstimate(40, 0, 86_400_000)).toBeNull();
    expect(daysLeftEstimate(-1, 10, 86_400_000)).toBe(0);
  });
});

describe('formatCreditRemainingAlert', () => {
  it('is fixed ops text: remaining, 24h spend, days left — never a key', () => {
    const text = formatCreditRemainingAlert({
      remainingUsd: 32.1,
      spendLast24hUsd: 8.4,
      daysLeft: 3.821,
      thresholdUsd: 40,
      startUsd: 200,
      startAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    expect(text).toContain('remaining $32.10 (below $40.00)');
    expect(text).toContain('spend last 24h: $8.40');
    expect(text).toContain('days left at that rate: 3.8');
    expect(text).toContain('start: $200.00 at 2026-11-01T00:00:00.000Z');
    expect(text).toContain('Switch the Prod ANTHROPIC_API_KEY');
    expect(text.toLowerCase()).not.toContain('sk-ant');
  });
});

describe('isAnthropicCreditError', () => {
  it('fires on a 400 credit-balance body and on a billing_error type', () => {
    const credit = apiError(
      400,
      'invalid_request_error',
      'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
    );
    expect(isAnthropicCreditError(credit)).toBe(true);
    expect(creditErrorShape(credit)).toEqual({
      httpStatus: 400,
      errorType: 'invalid_request_error',
    });
    expect(
      isAnthropicCreditError(
        apiError(400, 'billing_error', 'account cannot pay', { errorType: 'billing_error' }),
      ),
    ).toBe(true);
    expect(isAnthropicCreditError(apiError(402, 'invalid_request_error', 'Payment required'))).toBe(
      true,
    );
  });

  it('reads the SDK error through a coach wrapper', () => {
    const credit = apiError(400, 'invalid_request_error', 'Your credit balance is too low.');
    expect(
      isAnthropicCreditError(new Error('channel coach: agent loop failed', { cause: credit })),
    ).toBe(true);
  });

  it('does not fire on a usage-limit 400, a 429, or a request echo that mentions billing', () => {
    expect(
      isAnthropicCreditError(
        apiError(
          400,
          'invalid_request_error',
          'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
        ),
      ),
    ).toBe(false);
    expect(isAnthropicCreditError(apiError(429, 'rate_limit_error', 'rate limited'))).toBe(false);
    expect(
      isAnthropicCreditError(
        apiError(
          400,
          'invalid_request_error',
          'messages.0.content: text mentions a credit balance',
        ),
      ),
    ).toBe(false);
    expect(
      isAnthropicCreditError(apiError(400, 'invalid_request_error', 'invalid_request: bad json')),
    ).toBe(false);
  });
});

describe('formatCreditBillingErrorAlert', () => {
  it('carries status and type only, never the provider message', () => {
    const text = formatCreditBillingErrorAlert({
      httpStatus: 400,
      errorType: 'invalid_request_error',
    });
    expect(text).toContain('HTTP 400, invalid_request_error');
    expect(text).toContain('Switch the Prod ANTHROPIC_API_KEY');
    expect(text).not.toContain('credit balance');
    expect(text.toLowerCase()).not.toContain('sk-ant');
  });
});
