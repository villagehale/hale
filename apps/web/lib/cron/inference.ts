import Anthropic from '@anthropic-ai/sdk';
import { type AgentClient, runAgent } from '@hale/agent';
import type { Database } from '@hale/db';
import { MAX_FAMILIES_PER_RUN, selectFamiliesForRun } from './families';
import { buildCronGuardDeps } from './guards';
import { buildInferenceTools } from './inference-tools';
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

export interface InferenceDeps {
  client: AgentClient;
}

export interface InferenceResult {
  steps: number;
  hitMaxSteps: boolean;
}

let anthropicClient: Anthropic | undefined;

export function defaultInferenceDeps(): InferenceDeps {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set');
  }
  anthropicClient ??= new Anthropic({ apiKey });
  return { client: anthropicClient };
}

export async function runInferenceForFamily(
  familyId: string,
  database: Database,
  deps: InferenceDeps,
  now: Date = new Date(),
): Promise<InferenceResult> {
  const skill = await loadInferMemorySkill();
  const tools = buildInferenceTools(database, now);
  const guardDeps = buildCronGuardDeps(database);

  const result = await runAgent({
    skill,
    context: { familyId },
    tools,
    client: deps.client,
    maxSteps: MAX_STEPS,
    maxTokens: MAX_TOKENS,
    toolContext: { familyId, actor: 'system' },
    guardDeps,
  });

  return { steps: result.steps, hitMaxSteps: result.hitMaxSteps };
}

export interface InferenceCronResult {
  processed: number;
  results: Array<
    | { familyId: string; result: InferenceResult }
    | { familyId: string; error: string }
  >;
}

/**
 * The daily inference cron: run the memory inferencer for each family, bounded by
 * the per-run family cap (the budget blast-radius bound). A per-family failure is
 * recorded against that family and the loop continues — one bad family can't
 * starve the batch.
 */
export async function runInferenceCron(
  database: Database,
  deps: InferenceDeps = defaultInferenceDeps(),
  now: Date = new Date(),
): Promise<InferenceCronResult> {
  const familyIds = await selectFamiliesForRun(database, MAX_FAMILIES_PER_RUN.inference);

  const results: InferenceCronResult['results'] = [];
  for (const familyId of familyIds) {
    try {
      const result = await runInferenceForFamily(familyId, database, deps, now);
      results.push({ familyId, result });
    } catch (err) {
      results.push({ familyId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { processed: familyIds.length, results };
}
