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
export const SONNET5_MODEL = 'claude-sonnet-5';
export const OPUS_MODEL = 'claude-opus-4-8';

export type ModelId =
  | typeof HAIKU_MODEL
  | typeof SONNET_MODEL
  | typeof SONNET5_MODEL
  | typeof OPUS_MODEL;

/**
 * A skill declares the KIND of work it does, not a model id. The harness picks
 * the tier — so a re-tiering is a single table edit here, and skill files never
 * pin a concrete model (which would drift from the cost/latency assumptions).
 *
 * Tiers (per the user's subagent-tiering policy + this package's brief):
 *  - simple-lookup / triage → Haiku  (cheap, mechanical; triage is a bool+confidence
 *    skim over subject/from/snippet only — the E2 cost-shaped first stage that must
 *    discard >95% of inbox noise before any body is fetched)
 *  - classify / review / extract → Sonnet 5  (eval-proven; classify and extract both
 *    carry teen_content — a rule-#1 safety call, gated on teenAccuracy ≥ Sonnet-4.6 in
 *    the model matrix)
 *  - converse / draft / infer / discover → Sonnet (4.6)
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
  | 'high-stakes-judgment'
  | 'triage'
  | 'extract';

const TASK_MODEL: Record<AgentTask, ModelId> = {
  classify: SONNET5_MODEL,
  'simple-lookup': HAIKU_MODEL,
  converse: SONNET_MODEL,
  draft: SONNET_MODEL,
  review: SONNET5_MODEL,
  infer: SONNET_MODEL,
  discover: SONNET_MODEL,
  'high-stakes-judgment': OPUS_MODEL,
  triage: HAIKU_MODEL,
  extract: SONNET5_MODEL,
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
