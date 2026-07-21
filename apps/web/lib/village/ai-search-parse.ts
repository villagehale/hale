import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, pickModel, runAgent } from '@hale/agent';
import type { Database } from '@hale/db';
import { recordAgentRun, sonnetCostUsd } from '~/lib/agent-run';
import { buildGuardDeps } from '~/lib/coach/guards';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import {
  type VillageSearchIntent,
  keywordFallbackIntent,
  parseIntentAnswer,
} from './ai-search-intent';
import { loadParseVillageSearchSkill } from './ai-search-skill';

/**
 * The LLM intent-parse behind the Village natural-language search. It runs the house
 * agent seam — the SAME @hale/agent `runAgent` + `pickModel(skill.task)` + guarded
 * invoker + trace/record path the village rank agent uses (apps/web/lib/village/rank/
 * rank.ts) — over the `parse-village-search` skill (rule #2: instructions on disk,
 * never inline). The skill declares no tools: the model reads the prompt + the
 * family's coarse context and answers with a single JSON object, which we validate
 * into a typed VillageSearchIntent (mirrors rank.ts pulling its ordered ids out of
 * the model's free-text answer).
 *
 * Rule #8 — degrade visibly, never swallow: any failure of the model call OR an
 * unparseable answer falls back to the DETERMINISTIC keyword intent (the search
 * still runs, on the prompt's own words) and is logged + flagged `degraded`. A
 * genuine deploy bug (a missing skill file) is loaded OUTSIDE the boundary, so it
 * still surfaces rather than hiding behind the fallback.
 *
 * Rule #1 — the parser is given only COARSE context: the prompt, the coarse area,
 * and NON-TEEN children's ages (no name, no DOB, no teen age). A teen's age can
 * never enter the intent because it never enters the context.
 */

/** Recorded under the existing `discovery` agent_name enum — the intent parse is the
 * front half of the village discovery/search flow, so its cost lands in that bucket
 * (avoids an additive enum-value migration for a cost-attribution nicety). The
 * Langfuse trace name below stays granular for per-surface observability. */
const AGENT_NAME = 'discovery';

/** No tools + a small JSON answer → a single model round-trip; 1 step is the loop's
 * whole life here. */
const MAX_STEPS = 1;
const MAX_TOKENS = 512;

let defaultClient: Anthropic | undefined;

function anthropicClient(): AgentClient {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  defaultClient ??= new Anthropic({ apiKey });
  return defaultClient;
}

export interface ParseIntentInput {
  prompt: string;
  familyId: string;
  /** The family's NON-TEEN children's ages in completed months, for age resolution
   * ("my 3yo"). Teen ages are DELIBERATELY excluded (rule #1). */
  childrenAgesMonths: number[];
  /** Whether the family has a 13+ child, so the parser can family-scope an ask that
   * targets them WITHOUT ever receiving their age (rule #1). */
  hasTeen: boolean;
  /** The family's active COARSE area (rule #1) — context only, never precise. */
  areaCoarse: string | null;
}

export interface ParsedIntent {
  intent: VillageSearchIntent;
  /** True when the model call/parse failed and we fell back to keyword extraction. */
  degraded: boolean;
}

export async function parseVillageSearchIntent(
  input: ParseIntentInput,
  database: Database,
  client: AgentClient = anthropicClient(),
): Promise<ParsedIntent> {
  // Loaded OUTSIDE the fallback boundary: a missing/broken skill file is a deploy
  // bug that must surface, not degrade to keywords (rule #8).
  const skill = await loadParseVillageSearchSkill();
  const guardDeps = buildGuardDeps(database);
  const modelUsed = pickModel(skill.meta.task);

  const context = {
    prompt: input.prompt,
    area: input.areaCoarse,
    children: input.childrenAgesMonths.map((ageMonths) => ({ ageMonths })),
    hasTeen: input.hasTeen,
  };

  try {
    return await traceAgentRun(
      {
        name: 'village-search-intent',
        userId: 'system',
        tags: ['village-search-intent'],
        metadata: { familyId: input.familyId },
      },
      async (trace) => {
        const startedAt = Date.now();
        const result = await runAgent({
          skill,
          context,
          tools: [],
          client,
          maxSteps: MAX_STEPS,
          maxTokens: MAX_TOKENS,
          toolContext: { familyId: input.familyId, actor: 'system' },
          guardDeps,
        });

        trace.recordGeneration('village-search-intent-parse', { model: modelUsed, usage: result.usage });

        const intent = parseIntentAnswer(result.answer);
        await recordAgentRun(database, {
          familyId: input.familyId,
          agentName: AGENT_NAME,
          modelUsed,
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          costUsd: sonnetCostUsd(result.usage),
          latencyMs: Date.now() - startedAt,
          status: intent ? 'completed' : 'failed',
          langfuseTraceId: trace.traceId,
        });

        if (!intent) {
          // The model answered, but with no usable JSON — degrade visibly (rule #8).
          console.error(
            { familyId: input.familyId },
            'village-search: intent parse returned no usable JSON — falling back to keyword search',
          );
          return { intent: keywordFallbackIntent(input.prompt), degraded: true };
        }
        return { intent, degraded: false };
      },
    );
  } catch (err) {
    // The model call itself failed (network/API/timeout) — the search must still run
    // on the prompt's own words rather than error out (rule #8: log, don't swallow).
    console.error(
      { err, familyId: input.familyId },
      'village-search: intent parse call failed — falling back to keyword search',
    );
    return { intent: keywordFallbackIntent(input.prompt), degraded: true };
  }
}
