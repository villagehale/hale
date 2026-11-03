import type Anthropic from '@anthropic-ai/sdk';
import {
  type AgentClient,
  DEEPSEEK_MODEL,
  type LaneConfig,
  agentRunCostUsd,
  pickLane,
  runAgent,
} from '@hale/agent';
import type { Database } from '@hale/db';
import { recordAgentRun } from '~/lib/agent-run';
import { type SynthesisCronResult, runMemorySynthesis } from '~/lib/memory/synthesis';
import { type AbortedWindow, providerPreflight } from '~/lib/monitoring/provider-health';
import {
  CRON_SWEEP_CLIENT_OPTIONS,
  budgetedAiGateway,
  budgetedAnthropic,
} from '~/lib/pipeline/client';
import { parseModelMode } from '~/lib/pipeline/model-mode';
import {
  type ClearanceRefusal,
  type NonGoogleClearance,
  clearForNonAnthropic,
} from '~/lib/pipeline/provider-clearance';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import { MAX_FAMILIES_PER_RUN, selectFamiliesForRun } from './families';
import { buildCronGuardDeps } from './guards';
import { buildDistillTools, buildInferenceTools } from './inference-tools';
import { loadInferMemorySkill } from './skill';

/**
 * Runs the memory inferencer for ONE family on the @hale/agent harness — the
 * web-side mirror of the worker's runMemoryInferencer. The harness picks the
 * model from the skill's task (infer → Sonnet), dispatches every tool through the
 * GUARDED invoker (so each save_memory write is audited — rule #6), and HARD-STOPS
 * at maxSteps. The 0.7 confidence floor is enforced in the save_memory handler,
 * not just the prompt (a wrong fact poisons every downstream draft).
 *
 * Family-scoped (rule #1): the agent only ever reads/writes THIS family's memory.
 * Audit actor is 'system' (rule #6). The Anthropic client is injected so tests
 * drive the loop mechanics with a fake; inference QUALITY is an eval against real
 * cached Claude (rule #8), not asserted here.
 *
 * RESIDUAL (VIL-556, check-then-use): in candidate mode the Google witness is read ONCE,
 * before the agent loop. If a parent connects Gmail or Calendar and a sync lands while a
 * cleared family's run is in progress, the read tools can hand that new content to the
 * gateway model for the rest of the run. The window is one run (at most MAX_STEPS steps);
 * the next run reads the witness again and refuses. Closing it means re-checking inside
 * the read tools (inference-tools.ts), which this guard does not do.
 */

const MAX_STEPS = 8;
const MAX_TOKENS = 1024;

/**
 * What ONE family's agent leg needs. `client` is always Anthropic. The candidate adds a
 * gateway factory that takes a clearance, because the inferencer reads family-wide state
 * that carries Gmail- and Calendar-derived content for any family that connected Google
 * (VIL-556): the candidate runs only for a family the clearance witness clears.
 */
export type InferenceDeps =
  | { client: AgentClient; modelMode?: 'current' }
  | {
      client: AgentClient;
      modelMode: 'candidate';
      candidateClient: (clearance: NonGoogleClearance) => AgentClient;
    };

/**
 * What the whole window needs: the agent leg's client, plus the deterministic
 * memory-integrity pass that rides the same slot (VIL-354). Injected for the same
 * reason the client is — and NON-nullable, because "the pass did not run" is not an
 * outcome this cron is allowed to have silently. Observing without closing is the
 * pass's own `applied: false`, never a withheld dependency (rule #11).
 */
export type InferenceCronDeps = InferenceDeps & {
  synthesize: typeof runMemorySynthesis;
};

export interface InferenceResult {
  steps: number;
  hitMaxSteps: boolean;
  /** Why a requested candidate did not run for this family; null when none was requested
   * or it ran. */
  candidateRefusal: ClearanceRefusal | null;
}

let anthropicClient: Anthropic | undefined;

export function defaultInferenceDeps(): InferenceDeps {
  // Daily inference cron, maxDuration 300, multi-step loop per family: the sweep
  // budget bounds each request so one stall cannot eat the window (audit P1-7).
  const modelMode = parseModelMode(process.env.HALE_MEMORY_INFER_MODEL_MODE, 'memory inference');
  anthropicClient ??= budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS, { stage: 'memory_infer' });
  if (modelMode === 'candidate') {
    return {
      client: anthropicClient,
      modelMode,
      // Built per cleared family, so each gateway client is tied to its own clearance.
      candidateClient: (clearance) =>
        budgetedAiGateway(CRON_SWEEP_CLIENT_OPTIONS, clearance, { stage: 'memory_infer' }),
    };
  }
  return { client: anthropicClient, modelMode };
}

export function defaultInferenceCronDeps(): InferenceCronDeps {
  return { ...defaultInferenceDeps(), synthesize: runMemorySynthesis };
}

export async function runInferenceForFamily(
  familyId: string,
  database: Database,
  deps: InferenceDeps,
  now: Date = new Date(),
): Promise<InferenceResult> {
  const skill = await loadInferMemorySkill();
  // The inferencer reads events/episodes AND distills durable facts from recent
  // conversations — both tool sets, one guarded loop. Teen redaction is structural
  // in read_recent_conversations (rule #1).
  const tools = [...buildInferenceTools(database, now), ...buildDistillTools(database, now)];
  const guardDeps = buildCronGuardDeps(database);
  let client = deps.client;
  let lane: LaneConfig = pickLane(skill.meta.task);
  let candidateRefusal: ClearanceRefusal | null = null;
  if (deps.modelMode === 'candidate') {
    const decision = await clearForNonAnthropic(
      { kind: 'family_state', database, familyId },
      'memory inference',
    );
    if ('cleared' in decision) {
      client = deps.candidateClient(decision.cleared);
      lane = { model: DEEPSEEK_MODEL, thinking: 'disabled' };
    } else {
      candidateRefusal = decision.refused;
    }
  }
  const modelUsed = lane.model;

  // Trace the inference run: a scheduled run (userId 'system'), familyId is
  // correlating metadata. The mask keeps teen/PII out of the trace (rule #1).
  return traceAgentRun(
    {
      name: 'infer-memory',
      userId: 'system',
      tags: ['infer-memory'],
      metadata: { familyId },
    },
    async (trace) => {
      const startedAt = Date.now();
      let result: Awaited<ReturnType<typeof runAgent>>;
      try {
        result = await runAgent({
          skill,
          context: { familyId },
          tools,
          client,
          lane,
          maxSteps: MAX_STEPS,
          maxTokens: MAX_TOKENS,
          toolContext: { familyId, actor: 'system' },
          guardDeps,
        });
      } catch (err) {
        // Rule #8: record the failed run (real model, latency) without swallowing.
        await recordAgentRun(database, {
          familyId,
          agentName: 'infer-memory',
          modelUsed,
          promptTokens: 0,
          completionTokens: 0,
          costUsd: 0,
          latencyMs: Date.now() - startedAt,
          status: 'failed',
          langfuseTraceId: trace.traceId,
        });
        throw err;
      }

      trace.recordGeneration('infer-memory-loop', { model: modelUsed, usage: result.usage });

      await recordAgentRun(database, {
        familyId,
        agentName: 'infer-memory',
        modelUsed,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        costUsd: agentRunCostUsd(modelUsed, result.usage),
        cacheReadTokens: result.usage.cacheReadTokens,
        cacheWriteTokens: result.usage.cacheCreationTokens,
        latencyMs: Date.now() - startedAt,
        status: 'completed',
        langfuseTraceId: trace.traceId,
      });

      return { steps: result.steps, hitMaxSteps: result.hitMaxSteps, candidateRefusal };
    },
  );
}

export interface InferenceCronResult {
  processed: number;
  results: Array<
    { familyId: string; result: InferenceResult } | { familyId: string; error: string }
  >;
  /** The memory-integrity pass, which runs whether or not the agent leg does. */
  synthesis: SynthesisCronResult;
  /** Present when the provider pre-flight cancelled the window (VIL-255). */
  aborted?: AbortedWindow;
}

/**
 * The daily inference cron: run the memory inferencer for each family, bounded by
 * the per-run family cap (the budget blast-radius bound). A per-family failure is
 * recorded against that family and the loop continues — one bad family can't
 * starve the batch.
 *
 * The 06:00Z half of the 2026-08-01 incident: eight infer-memory runs failed against an
 * exhausted credit balance. One provider pre-flight (VIL-255) now stops the window
 * instead.
 */
export async function runInferenceCron(
  database: Database,
  deps: InferenceCronDeps = defaultInferenceCronDeps(),
  now: Date = new Date(),
): Promise<InferenceCronResult> {
  const familyIds = await selectFamiliesForRun(database, MAX_FAMILIES_PER_RUN.inference);

  // BEFORE the agent leg, so the inferencer's memory snapshot reads a tidied family
  // rather than the duplicates it is about to reason over — and OUTSIDE the provider
  // pre-flight below, deliberately: the pass makes zero model calls, so inheriting the
  // LLM kill switch would stop memory-integrity work because Anthropic's balance is
  // low. No provider, no provider gate.
  const synthesis = await deps.synthesize(database, familyIds, now);

  if (familyIds.length === 0) {
    return { processed: 0, results: [], synthesis };
  }

  const preflight = await providerPreflight(database, 'memory_inference', deps.client, now);
  if (!preflight.proceed) {
    return {
      processed: 0,
      results: [],
      synthesis,
      aborted: { ...preflight.abort, skipped: familyIds.length },
    };
  }

  const results: InferenceCronResult['results'] = [];
  for (const familyId of familyIds) {
    try {
      const result = await runInferenceForFamily(familyId, database, deps, now);
      results.push({ familyId, result });
    } catch (err) {
      results.push({ familyId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { processed: familyIds.length, results, synthesis };
}
