import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickModel, runAgent } from '@hale/agent';
import type { Database } from '@hale/db';
import { recordAgentRun, sonnetCostUsd } from '~/lib/agent-run';
import { buildGuardDeps } from '~/lib/coach/guards';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import { parseOrderedIds } from './rank';
import { buildRankTools } from './rank-tools';
import { loadCurateSkill } from './skill';

/**
 * The agent-driven shortlist curator. Same harness + same guarded signals as the
 * ranker, but the `curate-shortlist` skill assembles the FEW picks most worth
 * sharing to another family (best-fitting AND best-endorsed), not the full feed.
 * This is what the shareable /picks artifact draws from.
 *
 * Unlike ranking, curation is allowed to DROP candidates — a shortlist of two is
 * a fine answer. So we validate the model's chosen ids against the real candidate
 * set (dropping any hallucinated id, de-duplicating) but do NOT append the
 * leftovers: the omissions are the curation. The model decides which picks; the
 * code guarantees a pick is always a real candidate.
 *
 * Client injected for test mechanics (rule #8). Model via pickModel (discover →
 * Sonnet). On-demand + bounded spend (rule #7) — one agent loop, capped tokens.
 */

const MAX_STEPS = 6;
const MAX_TOKENS = 1024;
/** A shareable shortlist stays small — it must feel hand-picked, not dumped. */
const SHORTLIST_MAX = 8;

export interface CurateResult {
  /** The chosen pick ids, best first — a subset of the input candidate ids. */
  pickIds: string[];
}

let defaultClient: Anthropic | undefined;

function anthropicClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  defaultClient ??= new Anthropic({ apiKey });
  return defaultClient;
}

/** Keep only real, de-duplicated ids, bounded to the shortlist cap. The order is
 * the model's; the membership is enforced. */
export function reconcilePicks(modelPicks: string[], candidateIds: string[]): string[] {
  const valid = new Set(candidateIds);
  const seen = new Set<string>();
  const picks: string[] = [];
  for (const id of modelPicks) {
    if (valid.has(id) && !seen.has(id)) {
      seen.add(id);
      picks.push(id);
      if (picks.length >= SHORTLIST_MAX) break;
    }
  }
  return picks;
}

export interface CurateInput {
  familyId: string;
  candidateIds: string[];
  /** Written to audit_log.actor (rule #6). */
  actor: string;
}

export async function curateShortlist(
  input: CurateInput,
  database: Database,
  client: AgentClient = anthropicClient(),
): Promise<CurateResult> {
  if (input.candidateIds.length === 0) {
    return { pickIds: [] };
  }

  const skill = await loadCurateSkill();
  const tools = buildRankTools(database);
  const guardDeps = buildGuardDeps(database);
  const modelUsed = pickModel(skill.meta.task);

  return traceAgentRun(
    {
      name: 'curate-shortlist',
      userId: input.actor,
      tags: ['curate-shortlist'],
      metadata: { familyId: input.familyId },
    },
    async (trace) => {
      const startedAt = Date.now();
      const result = await runAgent({
        skill,
        context: { candidateIds: input.candidateIds },
        tools,
        client,
        maxSteps: MAX_STEPS,
        maxTokens: MAX_TOKENS,
        toolContext: { familyId: input.familyId, actor: input.actor },
        guardDeps,
      });

      trace.recordGeneration('curate-shortlist-loop', { model: modelUsed, usage: result.usage });

      const status = result.answer === null ? 'failed' : 'completed';
      await recordAgentRun(database, {
        familyId: input.familyId,
        agentName: 'curate-shortlist',
        modelUsed,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costUsd: sonnetCostUsd(result.usage),
        latencyMs: Date.now() - startedAt,
        status,
        langfuseTraceId: trace.traceId,
      });

      const pickIds = reconcilePicks(parseOrderedIds(result.answer), input.candidateIds);
      return { pickIds };
    },
  );
}
