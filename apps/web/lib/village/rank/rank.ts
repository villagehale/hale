import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickModel, runAgent } from '@hale/agent';
import type { Database } from '@hale/db';
import { recordAgentRun, sonnetCostUsd } from '~/lib/agent-run';
import { buildGuardDeps } from '~/lib/coach/guards';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import { buildRankTools } from './rank-tools';
import { loadRankSkill } from './skill';

/**
 * The agent-driven village ranker. Given a family's already-discovered candidate
 * ids, it runs the `rank-recommendations` skill on the @hale/agent harness: the
 * model reads the three signals (fit / trust / memory) through the GUARDED read
 * tools and decides the ORDER — most-fitting and most-trusted first. The order is
 * the moat; it is the model's judgement over the signals, NOT a scoring function.
 *
 * The model's final answer carries the ranked ids as a JSON array. We reconcile
 * that against the real candidate ids so the result is ALWAYS a clean permutation
 * of what exists: a hallucinated id is dropped, a forgotten id is appended in its
 * original order. The model decides the order; the code guarantees integrity (no
 * fabricated card can enter the feed, no real card can vanish).
 *
 * The Anthropic client is injected so tests drive the loop MECHANICS with a fake;
 * ranking QUALITY is an eval against real cached Claude (rule #8), not asserted
 * here. Model is chosen by the skill's task via pickModel (discover → Sonnet).
 */

const MAX_STEPS = 6;
const MAX_TOKENS = 1024;

export interface RankResult {
  /** Candidate ids in the order the family should see them — a permutation of the input. */
  orderedIds: string[];
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

/**
 * Pull the ordered id list out of the model's free-text answer. The skill is
 * instructed to emit a JSON array of ids; we take the first bracketed array of
 * strings. Anything unparseable yields an empty list, which reconciliation then
 * fills from the candidate order — so a malformed answer degrades to the
 * discovery order, never to a broken feed.
 */
export function parseOrderedIds(answer: string | null): string[] {
  if (!answer) return [];
  const match = answer.match(/\[[\s\S]*?\]/);
  if (!match) return [];
  try {
    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
}

/**
 * Reconcile the model's order against the real candidate ids: keep only real ids,
 * de-duplicate, then append any candidate the model omitted (in its original
 * order). The output is exactly the input set, reordered — the agent's judgement
 * applied, integrity enforced.
 */
export function reconcileOrder(modelOrder: string[], candidateIds: string[]): string[] {
  const valid = new Set(candidateIds);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const id of modelOrder) {
    if (valid.has(id) && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  for (const id of candidateIds) {
    if (!seen.has(id)) {
      ordered.push(id);
    }
  }
  return ordered;
}

export interface RankInput {
  familyId: string;
  /** The family's candidate ids, in their current (discovery) order. */
  candidateIds: string[];
  /** Written to audit_log.actor (rule #6). 'system' for the cached feed build. */
  actor: string;
}

/**
 * Ranks a family's candidates and returns them ordered. An empty candidate set
 * short-circuits (no model call, no spend) — there is nothing to order.
 */
export async function rankRecommendations(
  input: RankInput,
  database: Database,
  client: AgentClient = anthropicClient(),
): Promise<RankResult> {
  if (input.candidateIds.length === 0) {
    return { orderedIds: [] };
  }

  const skill = await loadRankSkill();
  const tools = buildRankTools(database);
  const guardDeps = buildGuardDeps(database);
  const modelUsed = pickModel(skill.meta.task);

  return traceAgentRun(
    {
      name: 'rank-recommendations',
      userId: input.actor,
      tags: ['rank-recommendations'],
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

      trace.recordGeneration('rank-recommendations-loop', { model: modelUsed, usage: result.usage });

      const status = result.answer === null ? 'failed' : 'completed';
      await recordAgentRun(database, {
        familyId: input.familyId,
        agentName: 'rank-recommendations',
        modelUsed,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costUsd: sonnetCostUsd(result.usage),
        latencyMs: Date.now() - startedAt,
        status,
        langfuseTraceId: trace.traceId,
      });

      // A run that produced no answer is recorded as failed, but the feed must
      // still render — degrade to the discovery order rather than throw and blank
      // the home page. reconcileOrder([]) returns the candidates unchanged.
      const orderedIds = reconcileOrder(parseOrderedIds(result.answer), input.candidateIds);
      return { orderedIds };
    },
  );
}
