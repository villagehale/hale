import { type Database, schema } from '@hale/db';

/**
 * The single web-side writer for agent_runs rows — every agent call path (the
 * draft pipeline's classifier/drafter/reviewer AND the standalone coach / digest /
 * inference / discovery runs) records cost/latency/model through here so prod has
 * real per-family cost observability (CLAUDE.md AI-systems rule).
 *
 * Rule #1: telemetry holds ids + counts only — never prompt/response content or
 * PII. costUsd is taken as a number and stored as the fixed-point string
 * numeric(12,6) wants (.toFixed(6)). Returns the new row id (recordDraft needs it
 * to set actions.draftedByAgentRunId).
 *
 * This module does NOT price tokens. Callers hand it a cost from the one rate
 * table, `estimateCostUsd` / `agentRunCostUsd` in @hale/agent — the sonnet/haiku
 * helpers that used to live here were a second copy that dropped the cache tiers
 * and had drifted to a stale Haiku rate.
 */

export interface RecordAgentRunInput {
  familyId: string;
  agentName: (typeof schema.agentRuns.$inferInsert)['agentName'];
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs?: number;
  /** True when any turn of the run read from the prompt cache (MEM-9 telemetry). */
  promptCacheHit?: boolean;
  /** 'completed' for a successful run, 'failed' when the agent threw (rule #8). */
  status: 'completed' | 'failed';
  langfuseTraceId?: string | null;
  /** Set only by the draft pipeline, which links the run to its event/action. */
  eventId?: string;
  actionId?: string;
}

export async function recordAgentRun(
  database: Database,
  input: RecordAgentRunInput,
): Promise<string> {
  const rows = await database
    .insert(schema.agentRuns)
    .values({
      familyId: input.familyId,
      eventId: input.eventId,
      actionId: input.actionId,
      agentName: input.agentName,
      modelUsed: input.modelUsed,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      costUsd: input.costUsd.toFixed(6),
      latencyMs: input.latencyMs,
      promptCacheHit: input.promptCacheHit,
      langfuseTraceId: input.langfuseTraceId,
      completedAt: new Date(),
      status: input.status,
    })
    .returning({ id: schema.agentRuns.id });

  const id = rows[0]?.id;
  if (!id) {
    throw new Error('recordAgentRun: agent_runs insert returned no row');
  }
  return id;
}
