import type Anthropic from '@anthropic-ai/sdk';
import { CRON_SWEEP_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { type AgentClient, agentRunCostUsd, pickModel, runAgent } from '@hale/agent';
import type { Database } from '@hale/db';
import { recordAgentRun } from '~/lib/agent-run';
import { type AbortedWindow, providerPreflight } from '~/lib/monitoring/provider-health';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import { type SynthesisCronResult, runMemorySynthesis } from '~/lib/memory/synthesis';
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
 */

const MAX_STEPS = 8;
const MAX_TOKENS = 1024;

/** What ONE family's agent leg needs. */
export interface InferenceDeps {
  client: AgentClient;
}

/**
 * What the whole window needs: the agent leg's client, plus the deterministic
 * memory-integrity pass that rides the same slot (VIL-354). Injected for the same
 * reason the client is — and NON-nullable, because "the pass did not run" is not an
 * outcome this cron is allowed to have silently. Observing without closing is the
 * pass's own `applied: false`, never a withheld dependency (rule #11).
 */
export interface InferenceCronDeps extends InferenceDeps {
  synthesize: typeof runMemorySynthesis;
}

export interface InferenceResult {
  steps: number;
  hitMaxSteps: boolean;
}

let anthropicClient: Anthropic | undefined;

export function defaultInferenceDeps(): InferenceDeps {
  // Daily inference cron, maxDuration 300, multi-step loop per family: the sweep
  // budget bounds each request so one stall cannot eat the window (audit P1-7).
  anthropicClient ??= budgetedAnthropic(CRON_SWEEP_CLIENT_OPTIONS);
  return { client: anthropicClient };
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
  const modelUsed = pickModel(skill.meta.task);

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
          client: deps.client,
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
        latencyMs: Date.now() - startedAt,
        status: 'completed',
        langfuseTraceId: trace.traceId,
      });

      return { steps: result.steps, hitMaxSteps: result.hitMaxSteps };
    },
  );
}

export interface InferenceCronResult {
  processed: number;
  results: Array<
    | { familyId: string; result: InferenceResult }
    | { familyId: string; error: string }
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
