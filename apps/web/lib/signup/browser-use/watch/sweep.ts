import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';

type ProviderWatchTarget = typeof schema.providerWatchTargets.$inferSelect;
import { and, asc, eq, gte, lte, sql } from 'drizzle-orm';
import { signupProviderHost } from '../../consent';
import { BrowserUseApiError, TERMINAL_RUN_STATUSES } from '../client';
import type { BrowserUseWatchApi } from './api';
import { usd } from './api';
import { BROWSER_USE_WATCH_OUTPUT_SCHEMA, type WatchOutput, parseWatchOutput } from './outcome';

/**
 * The Browser Use watch sweep (cron: /api/cron/browser-use-watch).
 *
 * Each provider host gets one Browser Use V4 workspace. The first run on a host asks
 * the agent to read the page and save a rerunnable script there; later runs rerun the
 * script against the live page and repair it if the page changed
 * (docs.browser-use.com/cloud/agent/scripts). Each run appends one
 * provider_watch_readings row, which the reply model reads as data
 * (./context.ts). Nothing here writes parent-facing words.
 *
 * SPEND IS CAPPED IN CODE, three ways:
 * - per run: `maxCostUsd` on the run (Browser Use's model-cost cap), and a deadline
 *   after which the run is cancelled;
 * - per sweep: at most WATCH_MAX_RUNS_PER_SWEEP runs;
 * - per day: no run starts once the last 24 hours of recorded cost plus one run's
 *   reserve would pass WATCH_DAY_MAX_COST_USD. Recorded cost is the session's full
 *   cost (browser, proxy, model) when Browser Use reports it.
 */
export const WATCH_RUN_MAX_COST_USD = 0.1;
/** What one run is assumed to cost before it starts: model cap plus browser time. */
export const WATCH_RUN_RESERVE_USD = 0.15;
export const WATCH_DAY_MAX_COST_USD = 1;
export const WATCH_MAX_RUNS_PER_SWEEP = 2;
export const WATCH_RUN_DEADLINE_MS = 2 * 60 * 1000;
/** Do not start another run after this much of the route's 300s has gone. */
export const WATCH_SWEEP_START_BUDGET_MS = 150 * 1000;
export const WATCH_POLL_INTERVAL_MS = 3000;
export const WATCH_SKILL = 'browser-use-watch';
/** Status and confirmation reads: Luna on medium (Sloane's audit, item 3). */
export const WATCH_MODEL = 'gpt-6-luna';
export const WATCH_MODEL_PARAMS = { reasoning: { effort: 'medium' } } as const;
const PROXY_COUNTRY = 'ca';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface WatchSweepDeps {
  api: BrowserUseWatchApi;
  loadTask: (skill: string) => Promise<string>;
  sleep: (ms: number) => Promise<void>;
  now: () => Date;
}

export type WatchRunOutcome = 'read' | 'unreadable' | 'failed' | 'timeout' | 'api_error';

export interface WatchSweepSummary {
  ran: number;
  outcomes: WatchRunOutcome[];
  spentLast24hUsd: number;
  stoppedBy: 'none' | 'day_cap' | 'run_cap' | 'time_budget';
}

export type WatchSweepResult =
  | ({ skipped: null } & WatchSweepSummary)
  | { skipped: 'flag_off' | 'not_configured' };

/** Script path inside the provider's workspace. One per watched page and kind. */
export function watchScriptPath(target: Pick<ProviderWatchTarget, 'sourceUrl' | 'kind'>): string {
  const digest = createHash('sha256').update(target.sourceUrl).digest('hex').slice(0, 10);
  return `scripts/${target.kind}-${digest}.py`;
}

export function watchFacts(
  target: Pick<ProviderWatchTarget, 'sourceUrl' | 'kind' | 'providerHost'>,
  scriptSaved: boolean,
): Record<string, unknown> {
  return {
    mode: scriptSaved ? 'rerun' : 'create',
    source_url: target.sourceUrl,
    provider_host: target.providerHost,
    kind: target.kind,
    script_path: watchScriptPath(target),
  };
}

function taskWithFacts(skillBody: string, facts: Record<string, unknown>): string {
  return `${skillBody.trim()}\n\n## This page\n\n\`\`\`json\n${JSON.stringify(facts, null, 2)}\n\`\`\`\n`;
}

export async function spentLast24hUsd(database: Database, now: Date): Promise<number> {
  const [row] = await database
    .select({
      total: sql<string | null>`coalesce(sum(${schema.providerWatchReadings.costUsd}), 0)`,
    })
    .from(schema.providerWatchReadings)
    .where(gte(schema.providerWatchReadings.readAt, new Date(now.getTime() - DAY_MS)));
  return usd(row?.total) ?? 0;
}

async function dueTargets(database: Database, now: Date, limit: number) {
  return database
    .select()
    .from(schema.providerWatchTargets)
    .where(
      and(
        eq(schema.providerWatchTargets.enabled, true),
        lte(schema.providerWatchTargets.nextRunAt, now),
        // Only pages some family agreed to and has not turned off.
        sql`exists (select 1 from ${schema.familyWatchSubscriptions} s where s.target_id = ${schema.providerWatchTargets.id} and s.removed_at is null)`,
      ),
    )
    .orderBy(asc(schema.providerWatchTargets.nextRunAt))
    .limit(limit);
}

async function workspaceFor(
  database: Database,
  api: BrowserUseWatchApi,
  providerHost: string,
): Promise<{ workspaceId: string; scriptSaved: boolean }> {
  const read = async () =>
    (
      await database
        .select()
        .from(schema.providerWatchWorkspaces)
        .where(eq(schema.providerWatchWorkspaces.providerHost, providerHost))
        .limit(1)
    )[0];
  const existing = await read();
  if (existing) {
    return {
      workspaceId: existing.browserUseWorkspaceId,
      scriptSaved: existing.scriptSavedAt !== null,
    };
  }
  const created = await api.createWorkspace(`hale-watch ${providerHost}`.slice(0, 100));
  await database
    .insert(schema.providerWatchWorkspaces)
    .values({ providerHost, browserUseWorkspaceId: created.id })
    .onConflictDoNothing();
  const row = await read();
  return {
    workspaceId: row?.browserUseWorkspaceId ?? created.id,
    scriptSaved: row?.scriptSavedAt != null,
  };
}

async function waitForRun(deps: WatchSweepDeps, runId: string): Promise<'terminal' | 'timeout'> {
  const deadline = deps.now().getTime() + WATCH_RUN_DEADLINE_MS;
  for (;;) {
    const status = await deps.api.getRunStatus(runId);
    if (TERMINAL_RUN_STATUSES.includes(status)) return 'terminal';
    if (deps.now().getTime() >= deadline) {
      await deps.api.cancelRun(runId).catch(() => undefined);
      return 'timeout';
    }
    await deps.sleep(WATCH_POLL_INTERVAL_MS);
  }
}

interface RunResult {
  outcome: WatchRunOutcome;
  runId: string | null;
  sessionId: string | null;
  output: WatchOutput | null;
  costUsd: number;
}

async function runTarget(
  database: Database,
  deps: WatchSweepDeps,
  target: ProviderWatchTarget,
): Promise<RunResult> {
  let runId: string | null = null;
  let sessionId: string | null = null;
  try {
    const workspace = await workspaceFor(database, deps.api, target.providerHost);
    const task = taskWithFacts(
      await deps.loadTask(WATCH_SKILL),
      watchFacts(target, workspace.scriptSaved),
    );
    const run = await deps.api.createRun({
      task,
      outputSchema: BROWSER_USE_WATCH_OUTPUT_SCHEMA,
      workspaceId: workspace.workspaceId,
      model: WATCH_MODEL,
      modelParams: { ...WATCH_MODEL_PARAMS },
      maxCostUsd: WATCH_RUN_MAX_COST_USD,
      agentmail: false,
      browserSettings: { proxyCountryCode: target.useProxy ? PROXY_COUNTRY : null, record: false },
    });
    runId = run.id;
    sessionId = run.sessionId;
    const waited = await waitForRun(deps, run.id);
    const summary = await deps.api.getRun(run.id);
    sessionId = summary.sessionId || sessionId;
    const costUsd =
      (sessionId ? await deps.api.getSessionCostUsd(sessionId).catch(() => null) : null) ??
      usd(summary.totalCostUsd) ??
      WATCH_RUN_RESERVE_USD;
    if (waited === 'timeout')
      return { outcome: 'timeout', runId, sessionId, output: null, costUsd };
    if (summary.status !== 'completed') {
      return { outcome: 'failed', runId, sessionId, output: null, costUsd };
    }
    const output = parseWatchOutput(summary.output);
    if (output?.scriptSaved && !workspace.scriptSaved) {
      await database
        .update(schema.providerWatchWorkspaces)
        .set({ scriptSavedAt: deps.now() })
        .where(eq(schema.providerWatchWorkspaces.providerHost, target.providerHost));
    }
    if (!output || !output.pageReached) {
      return { outcome: 'unreadable', runId, sessionId, output, costUsd };
    }
    return { outcome: 'read', runId, sessionId, output, costUsd };
  } catch (error) {
    // Once a run exists it costs money whatever failed after it (an API error, a
    // database write, a bug): try to stop it, and return the reserve so the caller
    // still writes a failed reading and the day cap counts it.
    if (runId !== null) {
      const created = runId;
      await deps.api.cancelRun(created).catch(() => undefined);
      return {
        outcome: 'api_error',
        runId,
        sessionId,
        output: null,
        costUsd: WATCH_RUN_RESERVE_USD,
      };
    }
    if (error instanceof BrowserUseApiError) {
      return { outcome: 'api_error', runId, sessionId, output: null, costUsd: 0 };
    }
    throw error;
  }
}

function readingRowOutcome(outcome: WatchRunOutcome): 'read' | 'unreadable' | 'failed' {
  if (outcome === 'read' || outcome === 'unreadable') return outcome;
  return 'failed';
}

export async function runBrowserUseWatchSweep(
  database: Database,
  deps: WatchSweepDeps | null,
  enabled: boolean,
): Promise<WatchSweepResult> {
  if (!enabled) return { skipped: 'flag_off' };
  if (!deps) return { skipped: 'not_configured' };
  const startedAt = deps.now().getTime();
  let spent = await spentLast24hUsd(database, deps.now());
  const targets = await dueTargets(database, deps.now(), WATCH_MAX_RUNS_PER_SWEEP + 1);
  const outcomes: WatchRunOutcome[] = [];
  let stoppedBy: WatchSweepSummary['stoppedBy'] = 'none';

  for (const target of targets) {
    if (outcomes.length >= WATCH_MAX_RUNS_PER_SWEEP) {
      stoppedBy = 'run_cap';
      break;
    }
    if (spent + WATCH_RUN_RESERVE_USD > WATCH_DAY_MAX_COST_USD) {
      stoppedBy = 'day_cap';
      break;
    }
    if (deps.now().getTime() - startedAt > WATCH_SWEEP_START_BUDGET_MS) {
      stoppedBy = 'time_budget';
      break;
    }
    // Claim first: a crash mid-run must not re-run the same page every hour.
    const now = deps.now();
    await database
      .update(schema.providerWatchTargets)
      .set({ nextRunAt: new Date(now.getTime() + target.intervalMinutes * 60 * 1000) })
      .where(eq(schema.providerWatchTargets.id, target.id));

    const result = await runTarget(database, deps, target);
    outcomes.push(result.outcome);
    spent += result.costUsd;
    if (result.runId === null && result.costUsd === 0) continue;
    await database.insert(schema.providerWatchReadings).values({
      targetId: target.id,
      providerHost: signupProviderHost(target.providerHost),
      outcome: readingRowOutcome(result.outcome),
      runId: result.runId,
      sessionId: result.sessionId,
      reading: result.output
        ? {
            fetchedAt: result.output.fetchedAt,
            items: result.output.items,
          }
        : null,
      costUsd: result.costUsd.toFixed(4),
      readAt: deps.now(),
    });
  }
  return { skipped: null, ran: outcomes.length, outcomes, spentLast24hUsd: spent, stoppedBy };
}
