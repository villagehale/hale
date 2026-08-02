import { type Database, schema } from '@hale/db';
import { and, count, gte, lt } from 'drizzle-orm';
import {
  type ProviderHealthDeps,
  defaultProviderHealthDeps,
  raiseProviderIncident,
} from './provider-health';

/**
 * VIL-255 · the failed-run backstop.
 *
 * The pre-flight only catches failures the provider ANSWERS with. A bad deploy, a
 * broken tool, a skill that stopped parsing, or an outage that begins mid-window all
 * look healthy to a one-token probe and still fail every family. So the outcome of the
 * window that just closed is read directly: if most of the runs that finished failed,
 * the founder hears about it through the same alert path, deduped the same way.
 *
 * Runs still `in_progress` are excluded from BOTH counts. At the moment this reads,
 * some runs legitimately have not finished; scoring them as failures would page on
 * every busy window, and scoring them as successes would hide a real one. The honest
 * denominator is the runs that reached an outcome.
 */

/** The trailing window read on each sweep. One hour: the sweep runs hourly, so this is
 * exactly "the window that just closed" for every LLM cron in the schedule. */
export const RUN_SPIKE_WINDOW_MINUTES = 60;

/** Below this many finished runs a ratio means nothing — one failed run out of one is
 * 100% and is a single family's bad data, not an outage. */
export const RUN_SPIKE_MIN_RUNS = 4;

/** A spike is STRICTLY more than half — an even split is bad, but it is not the
 * everything-is-down signal this alert is reserved for. */
const RUN_SPIKE_FAILED_RATIO = 0.5;

/** A grouped count of agent_runs by status, as Drizzle returns it. */
export interface RunStatusCount {
  status: string;
  count: number;
}

export interface RunFailureSummary {
  /** Runs that reached an outcome (completed or failed) in the window. */
  total: number;
  failed: number;
  windowStart: Date;
  windowEnd: Date;
  spiked: boolean;
}

/** Pure — the threshold rule, tested against worked counts without a DB. */
export function summarizeRunFailures(
  rows: RunStatusCount[],
  windowStart: Date,
  windowEnd: Date,
): RunFailureSummary {
  let failed = 0;
  let completed = 0;
  for (const row of rows) {
    if (row.status === 'failed') failed += row.count;
    else if (row.status === 'completed') completed += row.count;
  }
  const total = failed + completed;
  return {
    total,
    failed,
    windowStart,
    windowEnd,
    spiked: total >= RUN_SPIKE_MIN_RUNS && failed / total > RUN_SPIKE_FAILED_RATIO,
  };
}

export interface RunFailureSpikeResult {
  summary: RunFailureSummary;
  alerted: boolean;
  deduped: boolean;
}

/**
 * Read the trailing window's agent_runs outcomes and page the founder on a spike.
 * Runs hourly from the ops cron; the alert is deduped per incident like every other.
 */
export async function checkRunFailureSpike(
  database: Database,
  deps: ProviderHealthDeps = defaultProviderHealthDeps(),
  now: Date = new Date(),
): Promise<RunFailureSpikeResult> {
  const windowStart = new Date(now.getTime() - RUN_SPIKE_WINDOW_MINUTES * 60_000);

  const rows = await database
    .select({ status: schema.agentRuns.status, count: count() })
    .from(schema.agentRuns)
    .where(
      and(gte(schema.agentRuns.startedAt, windowStart), lt(schema.agentRuns.startedAt, now)),
    )
    .groupBy(schema.agentRuns.status);

  const summary = summarizeRunFailures(rows, windowStart, now);
  if (!summary.spiked) {
    return { summary, alerted: false, deduped: false };
  }

  const outcome = await raiseProviderIncident(
    database,
    {
      kind: 'run_spike',
      failed: summary.failed,
      total: summary.total,
      windowStart,
      windowEnd: now,
    },
    deps,
    now,
  );
  return { summary, ...outcome };
}
