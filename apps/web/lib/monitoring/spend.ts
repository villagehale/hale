import { type Database, schema } from '@hale/db';
import { gte } from 'drizzle-orm';
import { captureException } from './sentry';

/**
 * Anthropic spend alerting. agent_runs.cost_usd carries the per-run USD cost (the
 * single web-side writer in lib/agent-run.ts records it for every agent call).
 * This sums the current calendar month's runs and alerts — Sentry capture +
 * console.error — when the total crosses ANTHROPIC_SPEND_ALERT_USD, so a runaway
 * agent loop is caught early instead of surfacing on the bill.
 *
 * The summing/threshold logic is the pure summarizeSpend so it is unit-tested
 * without a DB; the cron route owns the month-window query and the alert.
 */

/** Default monthly alert threshold (USD) when ANTHROPIC_SPEND_ALERT_USD is unset. */
const DEFAULT_THRESHOLD_USD = 200;

/** A row carrying the numeric(12,6) cost as the STRING Drizzle returns (null when
 * a run never recorded a cost). */
export interface SpendRow {
  costUsd: string | null;
}

export interface SpendSummary {
  totalUsd: number;
  threshold: number;
  /** True when totalUsd STRICTLY exceeds the threshold. */
  exceeded: boolean;
}

/** Sum the string cost_usd values and compare to the threshold. A null cost is
 * treated as zero (a run that never recorded a cost). */
export function summarizeSpend(rows: SpendRow[], thresholdUsd: number): SpendSummary {
  const totalUsd = rows.reduce((sum, row) => sum + (row.costUsd ? Number(row.costUsd) : 0), 0);
  return { totalUsd, threshold: thresholdUsd, exceeded: totalUsd > thresholdUsd };
}

/** The configured monthly alert threshold, or the sane default. */
export function spendThresholdUsd(): number {
  const raw = process.env.ANTHROPIC_SPEND_ALERT_USD;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : DEFAULT_THRESHOLD_USD;
}

/** First instant of the current calendar month, UTC. */
function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Read this month's agent_runs costs, summarize, and raise an alert when over the
 * threshold (Sentry capture, no-op without a DSN, + console.error so it's never
 * fully silent). Returns the summary. The cron route gates the spend.
 */
export async function checkMonthlySpend(
  database: Database,
  now: Date = new Date(),
): Promise<SpendSummary> {
  const rows = await database
    .select({ costUsd: schema.agentRuns.costUsd })
    .from(schema.agentRuns)
    .where(gte(schema.agentRuns.startedAt, startOfMonthUtc(now)));

  const summary = summarizeSpend(rows, spendThresholdUsd());

  if (summary.exceeded) {
    const message = `Anthropic spend alert: $${summary.totalUsd.toFixed(2)} this month exceeds $${summary.threshold.toFixed(2)}`;
    captureException(new Error(message));
    console.error({ summary }, message);
  }

  return summary;
}
