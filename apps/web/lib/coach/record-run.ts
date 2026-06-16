import { type Database, schema } from '@hale/db';
import type { CoachRunMetrics } from './coach';

/**
 * Records the coach Q&A call as a standalone agent_runs row for cost tracking.
 * The coach answer is read-style (it mutates no family domain state and is not an
 * `actions` pipeline row), so — like the worker's standalone recordAgentRun path
 * (e.g. the duplicate-event classifier run) — it writes an agent_runs row without
 * an audit_log transition; agent_runs already carries family_id + cost for the
 * month-to-date spend scan. numeric(12,6) takes cost as a fixed-point string.
 */
export async function recordCoachRun(
  familyId: string,
  metrics: CoachRunMetrics,
  database: Database,
): Promise<string> {
  const rows = await database
    .insert(schema.agentRuns)
    .values({
      familyId,
      agentName: 'coach',
      modelUsed: metrics.modelUsed,
      promptTokens: metrics.promptTokens,
      completionTokens: metrics.completionTokens,
      costUsd: metrics.costUsd.toFixed(6),
      latencyMs: metrics.latencyMs,
      completedAt: new Date(),
      status: 'completed',
    })
    .returning({ id: schema.agentRuns.id });

  const id = rows[0]?.id;
  if (!id) {
    throw new Error('coach agent_runs insert returned no row');
  }
  return id;
}
