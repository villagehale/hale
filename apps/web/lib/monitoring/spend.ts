import { type Database, schema } from '@hale/db';
import { gte } from 'drizzle-orm';
import { type ProviderIncidentDeps, raiseProviderIncident } from '~/lib/monitoring/provider-health';

/**
 * Anthropic spend alerting. agent_runs.cost_usd carries the per-run USD cost for the
 * agent lanes that record one (lib/agent-run.ts is the shared insert helper). This sums
 * the current calendar month's runs and pages Slack #ops — once per incident window,
 * through the provider-incident claim — when the total reaches ANTHROPIC_SPEND_ALERT_USD,
 * so a runaway agent loop is caught early instead of surfacing on the bill.
 *
 * The sum misses lanes that write no cost row, the pre-flight probes, and eval/dev spend
 * on the same account, so it is NOT an early warning for the provider's usage-limit 400;
 * the provider-health classifier is the alarm for that.
 *
 * The summing/threshold logic is the pure summarizeSpend so it is unit-tested
 * without a DB; the cron route owns the month-window query and the alert.
 */

const SPEND_ALERT_ENV = 'ANTHROPIC_SPEND_ALERT_USD';

/** A row carrying the numeric(12,6) cost as the STRING Drizzle returns (null when
 * a run never recorded a cost). */
export interface SpendRow {
  costUsd: string | null;
}

export interface SpendSummary {
  totalUsd: number;
  threshold: number;
  /** True when totalUsd is at or above the threshold. */
  reached: boolean;
}

/** Sum the string cost_usd values and compare to the threshold. A null cost is
 * treated as zero (a run that never recorded a cost). */
export function summarizeSpend(rows: SpendRow[], thresholdUsd: number): SpendSummary {
  const totalUsd = rows.reduce((sum, row) => sum + (row.costUsd ? Number(row.costUsd) : 0), 0);
  return { totalUsd, threshold: thresholdUsd, reached: totalUsd >= thresholdUsd };
}

/** The configured monthly alert threshold, or null when it is unset, not a number, or
 * not above zero. There is no default: an assumed figure is an alert watching nothing. */
export function spendThresholdUsd(): number | null {
  const raw = process.env[SPEND_ALERT_ENV];
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** What the hourly spend check did, named so the cron JSON says it (rule #11). */
export type SpendAlert =
  | 'threshold_not_configured'
  | 'below_threshold'
  | 'paged'
  | 'deduped'
  | 'page_not_delivered';

/** First instant of the current calendar month, UTC. */
function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * Read this month's agent_runs costs, summarize, and page #ops when the total reaches
 * the threshold. An unset threshold is logged by name on every run and pages nobody.
 */
export async function checkMonthlySpend(
  database: Database,
  deps: ProviderIncidentDeps,
  now: Date = new Date(),
): Promise<{ totalUsd: number; threshold: number | null; alert: SpendAlert }> {
  const rows = await database
    .select({ costUsd: schema.agentRuns.costUsd })
    .from(schema.agentRuns)
    .where(gte(schema.agentRuns.startedAt, startOfMonthUtc(now)));

  const threshold = spendThresholdUsd();
  if (threshold === null) {
    const { totalUsd } = summarizeSpend(rows, 0);
    console.error(`Anthropic spend alert: ${SPEND_ALERT_ENV} is not set — nobody is paged`);
    return { totalUsd, threshold: null, alert: 'threshold_not_configured' };
  }

  const summary = summarizeSpend(rows, threshold);
  if (!summary.reached) {
    return { totalUsd: summary.totalUsd, threshold, alert: 'below_threshold' };
  }

  const outcome = await raiseProviderIncident(
    database,
    { kind: 'spend_threshold', totalUsd: summary.totalUsd, thresholdUsd: threshold },
    deps,
    now,
  );
  const alert: SpendAlert = outcome.deduped
    ? 'deduped'
    : outcome.alerted
      ? 'paged'
      : 'page_not_delivered';
  return { totalUsd: summary.totalUsd, threshold, alert };
}
