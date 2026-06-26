/**
 * Single source of truth for model ids + the task → model routing.
 *
 * Before this package, model ids lived in apps/worker/src/anthropic/client.ts
 * and apps/web/lib/coach/model.ts read them back across the process boundary.
 * Both should import HAIKU_MODEL / SONNET_MODEL / OPUS_MODEL from here instead,
 * so a model bump is one edit, not a readFileSync-parse that can silently drift.
 */

export const HAIKU_MODEL = 'claude-haiku-4-5';
export const SONNET_MODEL = 'claude-sonnet-4-6';
export const OPUS_MODEL = 'claude-opus-4-8';

export type ModelId = typeof HAIKU_MODEL | typeof SONNET_MODEL | typeof OPUS_MODEL;

/**
 * A skill declares the KIND of work it does, not a model id. The harness picks
 * the tier — so a re-tiering is a single table edit here, and skill files never
 * pin a concrete model (which would drift from the cost/latency assumptions).
 *
 * Tiers (per the user's subagent-tiering policy + this package's brief):
 *  - simple-lookup → Haiku  (cheap, mechanical)
 *  - classify / converse / draft / review / infer / discover → Sonnet
 *    (classify carries teen_content — a rule-#1 safety call Haiku misses; eval VIL-143)
 *  - high-stakes-judgment → Opus  (run-rarely, judgment-dense)
 */
export type AgentTask =
  | 'classify'
  | 'simple-lookup'
  | 'converse'
  | 'draft'
  | 'review'
  | 'infer'
  | 'discover'
  | 'high-stakes-judgment';

const TASK_MODEL: Record<AgentTask, ModelId> = {
  classify: SONNET_MODEL,
  'simple-lookup': HAIKU_MODEL,
  converse: SONNET_MODEL,
  draft: SONNET_MODEL,
  review: SONNET_MODEL,
  infer: SONNET_MODEL,
  discover: SONNET_MODEL,
  'high-stakes-judgment': OPUS_MODEL,
};

/** The set of valid task names — used by the skill loader to validate frontmatter. */
export const AGENT_TASKS = Object.keys(TASK_MODEL) as AgentTask[];

/** Map a skill's declared task to the model tier that should run it. */
export function pickModel(task: AgentTask): ModelId {
  const model = TASK_MODEL[task];
  if (!model) {
    throw new Error(`pickModel: unknown task '${task}'`);
  }
  return model;
}

/** Type guard: is `value` a known AgentTask? Lets the skill loader fail loudly on a typo. */
export function isAgentTask(value: string): value is AgentTask {
  return value in TASK_MODEL;
}
