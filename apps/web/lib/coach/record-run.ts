import type { Database } from '@hale/db';
import { recordAgentRun } from '~/lib/agent-run';
import type { CoachRunMetrics } from './coach';

/**
 * Records the Concierge Q&A call as a standalone agent_runs row for cost tracking.
 * The coach answer is read-style (it mutates no family domain state and is not an
 * `actions` pipeline row), so — like the worker's standalone recordAgentRun path —
 * it writes an agent_runs row without an audit_log transition; agent_runs already
 * carries family_id + cost for the month-to-date spend scan.
 */
export async function recordCoachRun(
  familyId: string,
  metrics: CoachRunMetrics,
  database: Database,
  status: 'completed' | 'failed' = 'completed',
  langfuseTraceId: string | null = null,
): Promise<string> {
  return recordAgentRun(database, {
    familyId,
    agentName: 'ask-hale',
    modelUsed: metrics.modelUsed,
    promptTokens: metrics.promptTokens,
    completionTokens: metrics.completionTokens,
    costUsd: metrics.costUsd,
    latencyMs: metrics.latencyMs,
    status,
    langfuseTraceId,
  });
}
