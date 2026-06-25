import { describe, expect, it } from 'vitest';
import { summarizeSpend } from './spend';

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

  it('does NOT flag when the total is at or below the threshold', () => {
    const summary = summarizeSpend([{ costUsd: '40.000000' }, { costUsd: '10.000000' }], 50);
    expect(summary.totalUsd).toBeCloseTo(50, 6);
    expect(summary.exceeded).toBe(false);
  });

  it('flags when the total strictly exceeds the threshold', () => {
    const summary = summarizeSpend([{ costUsd: '40.000000' }, { costUsd: '10.000001' }], 50);
    expect(summary.exceeded).toBe(true);
    expect(summary.threshold).toBe(50);
  });

  it('is a zero total (not flagged) for an empty month', () => {
    const summary = summarizeSpend([], 50);
    expect(summary.totalUsd).toBe(0);
    expect(summary.exceeded).toBe(false);
  });
});
