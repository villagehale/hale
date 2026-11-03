import { afterEach, describe, expect, it, vi } from 'vitest';
import { spendThresholdUsd, summarizeSpend } from './spend';

/**
 * The spend summary sums agent_runs.cost_usd (stored as the numeric(12,6) STRING
 * Drizzle returns) and flags when the month's total crosses the alert threshold.
 * Pure, so the sum + threshold logic is tested without a DB; the cron route owns
 * the date-window query and the alerting.
 */
describe('summarizeSpend', () => {
  it('sums the string cost_usd values to a number', () => {
    const summary = summarizeSpend([{ costUsd: '1.500000' }, { costUsd: '0.250000' }], 100);
    expect(summary.totalUsd).toBeCloseTo(1.75, 6);
  });

  it('treats a null cost_usd as zero (a run that never recorded a cost)', () => {
    const summary = summarizeSpend([{ costUsd: '2.000000' }, { costUsd: null }], 100);
    expect(summary.totalUsd).toBeCloseTo(2, 6);
  });

  it('flags when the total reaches the threshold exactly', () => {
    const summary = summarizeSpend([{ costUsd: '40.000000' }, { costUsd: '10.000000' }], 50);
    expect(summary.totalUsd).toBeCloseTo(50, 6);
    expect(summary.reached).toBe(true);
    expect(summary.threshold).toBe(50);
  });

  it('does NOT flag just below the threshold', () => {
    const summary = summarizeSpend([{ costUsd: '40.000000' }, { costUsd: '9.999999' }], 50);
    expect(summary.reached).toBe(false);
  });

  it('is a zero total (not flagged) for an empty month', () => {
    const summary = summarizeSpend([], 50);
    expect(summary.totalUsd).toBe(0);
    expect(summary.reached).toBe(false);
  });
});

describe('spendThresholdUsd', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is null when ANTHROPIC_SPEND_ALERT_USD is unset — no silent default', () => {
    vi.stubEnv('ANTHROPIC_SPEND_ALERT_USD', undefined);
    expect(spendThresholdUsd()).toBeNull();
  });

  it('reads a positive dollar figure', () => {
    vi.stubEnv('ANTHROPIC_SPEND_ALERT_USD', '150');
    expect(spendThresholdUsd()).toBe(150);
  });

  it('is null for a value that is not a number, or not above zero', () => {
    vi.stubEnv('ANTHROPIC_SPEND_ALERT_USD', 'abc');
    expect(spendThresholdUsd()).toBeNull();
    vi.stubEnv('ANTHROPIC_SPEND_ALERT_USD', '0');
    expect(spendThresholdUsd()).toBeNull();
  });
});
