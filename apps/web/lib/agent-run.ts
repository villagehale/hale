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
 */

const SONNET_RATE = { inputPerMTok: 3, outputPerMTok: 15 } as const;
const HAIKU_RATE = { inputPerMTok: 0.8, outputPerMTok: 4 } as const;
const PER_MTOK = 1_000_000;

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
}

/** USD cost of a run at the given token rate. */
function costAt(rate: { inputPerMTok: number; outputPerMTok: number }, usage: AgentUsage): number {
  return (
    (usage.promptTokens * rate.inputPerMTok) / PER_MTOK +
    (usage.completionTokens * rate.outputPerMTok) / PER_MTOK
  );
}

/** Sonnet-tier cost (drafter / reviewer / coach / digest / inference / discovery). */
export function sonnetCostUsd(usage: AgentUsage): number {
  return costAt(SONNET_RATE, usage);
}

/** Haiku-tier cost (classifier). */
export function haikuCostUsd(usage: AgentUsage): number {
  return costAt(HAIKU_RATE, usage);
}

export interface RecordAgentRunInput {
  familyId: string;
  agentName: (typeof schema.agentRuns.$inferInsert)['agentName'];
  modelUsed: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs?: number;
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
