/**
 * Single source of truth for model ids + the task → LANE routing.
 *
 * Before this package, model ids lived in apps/worker/src/anthropic/client.ts
 * and apps/web/lib/coach/model.ts read them back across the process boundary.
 * Both should import HAIKU_MODEL / SONNET_MODEL / OPUS_MODEL from here instead,
 * so a model bump is one edit, not a readFileSync-parse that can silently drift.
 */

/**
 * Every lane runs on the Claude 5.5 generation (founder directive 2026-10-11: no
 * exceptions, no fallback to an older model). The ids are tier names, not version
 * names, so the next generation is again one edit here.
 */
export const HAIKU_MODEL = 'claude-haiku-5-5';
export const SONNET_MODEL = 'claude-sonnet-5-5';
export const OPUS_MODEL = 'claude-opus-5-5';
export const DEEPSEEK_MODEL = 'deepseek/deepseek-v4.1-flash';

/**
 * The eval grader for rubrics Haiku cannot hold. Not a lane: no production call uses
 * it. Opus rather than Sonnet because those suites run their subject on Sonnet, and a
 * model grading its own output is not a second opinion.
 */
export const JUDGE_MODEL = 'claude-opus-5-5';

export type ModelId =
  | typeof HAIKU_MODEL
  | typeof SONNET_MODEL
  | typeof OPUS_MODEL
  | typeof DEEPSEEK_MODEL;

/**
 * A skill declares the KIND of work it does, not a model id. The harness picks
 * the tier — so a re-tiering is a single table edit here, and skill files never
 * pin a concrete model (which would drift from the cost/latency assumptions).
 *
 * Tiers (per the user's subagent-tiering policy + this package's brief):
 *  - simple-lookup / triage / acknowledge → Haiku  (cheap, mechanical; triage is a
 *    bool+confidence skim over subject/from/snippet only — the E2 cost-shaped first
 *    stage that must discard >95% of inbox noise before any body is fetched.
 *    `acknowledge` writes ONE warm sentence around facts that are already decided and
 *    lint-checked afterwards, so the tier buys warmth, not judgment — and it sits on
 *    the inbound-SMS hot path, where latency is a parent watching three dots.
 *    `screen` decides only WHICH fixed line answers an inbound text and never a word of
 *    it — the stage exists to cost a fraction of the coach turn it replaces, so anything
 *    dearer than Haiku defeats its whole reason for being. Its error case falls through
 *    to the coach, so a wrong screen costs a deflection, never an answer.
 *    `answer` writes the one brief reply to a question about the WORLD — two sentences,
 *    no family context, no tools — behind that same screen and on that same hot path,
 *    so it is held to the same cost and latency shape. Its error case falls back to a
 *    fixed line, so the tier can cost a dull answer and never a fact about a child.
 *    `speak` is one turn of a live PHONE CALL: the parent is holding the line, so time
 *    to first token is the whole experience and a tier that thinks for two seconds is
 *    worse at this job than one that starts talking. It calls no tools and writes about
 *    forty words, which is the shape Haiku is best at)
 *  - classify / review / extract → Sonnet  (classify and extract both carry
 *    teen_content — a rule-#1 safety call, gated on teenAccuracy in the model matrix)
 *  - converse / draft / infer / discover → Sonnet
 *  - high-stakes-judgment → Opus  (run-rarely, judgment-dense)
 *  - plan → Opus  (the plan a parent said yes to and is waiting on)
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
  | 'plan'
  | 'triage'
  | 'extract'
  | 'acknowledge'
  | 'screen'
  | 'answer'
  | 'speak';

/**
 * How hard the model works before it answers. Rendered into the prompt by the
 * API, so it is LANE-scoped and fixed for a thread: changing it mid-conversation
 * rewrites the cached prefix and throws away every cache read on that thread.
 * Steer an individual step with appended prose, never by moving the lane's effort.
 */
export type Effort = 'low' | 'medium' | 'high' | 'xhigh';

/**
 * A lane: the model plus the reasoning knobs that belong to it.
 *
 * The union is the point: each 5.5 tier accepts a different thinking-off shape, and
 * the wrong one is a 400, so every 400 shape is unrepresentable rather than merely
 * discouraged (claude-api docs, Claude 5.5 migration guides, 2026-10):
 *
 *  - Haiku 5.5 accepts `thinking: disabled`, but only at effort `high` or below.
 *  - Sonnet 5.5 rejects `disabled`; its thinking-off shape is `between_tools`, also
 *    `high` or below, and no other model accepts `between_tools`.
 *  - Opus 5.5 cannot turn thinking off at all; effort is its only control.
 *
 * Thinking is spelled out on every lane rather than left to the model default,
 * because on Haiku 5.5 an omitted `thinking` means adaptive at `medium` — and since
 * `max_tokens` caps thinking AND reply text together, inheriting that on a lane
 * budgeted at 128 tokens is how a reply silently truncates.
 */
export type LaneConfig =
  | { model: typeof DEEPSEEK_MODEL; thinking: 'disabled' }
  | { model: typeof HAIKU_MODEL; thinking: 'adaptive'; effort: Effort }
  | { model: typeof HAIKU_MODEL; thinking: 'disabled'; effort: ThinkingOffEffort }
  | { model: typeof SONNET_MODEL; thinking: 'adaptive'; effort: Effort }
  | { model: typeof SONNET_MODEL; thinking: 'between_tools'; effort: ThinkingOffEffort }
  | { model: typeof OPUS_MODEL; thinking: 'adaptive'; effort: Effort };

/** Thinking-off shapes are a 400 above `high` on every tier that has one. */
type ThinkingOffEffort = Exclude<Effort, 'xhigh'>;

/**
 * The lane matrix.
 *
 * `effort` is set explicitly on every lane. The classify / review / extract lanes keep
 * `adaptive` + `high`; they carry teen_content (rule #1) and are not re-tuned without
 * re-running the teenAccuracy gate.
 */
const TASK_LANE: Record<AgentTask, LaneConfig> = {
  classify: { model: SONNET_MODEL, thinking: 'adaptive', effort: 'high' },
  review: { model: SONNET_MODEL, thinking: 'adaptive', effort: 'high' },
  extract: { model: SONNET_MODEL, thinking: 'adaptive', effort: 'high' },

  // `high` is the floor on the inline chat lane, not a tuning preference: effort governs
  // how readily the model reaches for a tool, and below `high` it stopped calling
  // find_activities on the flagship both-halves fixture (measured on Sonnet 5).
  converse: { model: SONNET_MODEL, thinking: 'adaptive', effort: 'high' },

  discover: { model: SONNET_MODEL, thinking: 'adaptive', effort: 'medium' },

  // The two lanes that ran with thinking off before the move keep it off.
  draft: { model: SONNET_MODEL, thinking: 'between_tools', effort: 'high' },
  infer: { model: SONNET_MODEL, thinking: 'between_tools', effort: 'high' },

  // Run-rarely and judgment-dense: the one lane worth `xhigh`.
  'high-stakes-judgment': { model: OPUS_MODEL, thinking: 'adaptive', effort: 'xhigh' },
  // Opus at `high`, not `xhigh`: a parent is waiting on this one, and `xhigh` put the
  // plan's p95 at 34 s (Barton, 2026-10-11).
  plan: { model: OPUS_MODEL, thinking: 'adaptive', effort: 'high' },

  // Haiku lanes. Effort is Haiku 5.5's lever: with thinking off, the acknowledge and
  // answer lanes failed evals that adaptive at `medium` passes (re-record 2026-10-11), and
  // forceToolJson re-asks thinking-off any structured turn that spends its budget
  // thinking. `low` where the answer is a bool. The phone call keeps thinking off: a
  // parent holding the line hears time-to-first-token, and it writes about forty words.
  'simple-lookup': { model: HAIKU_MODEL, thinking: 'adaptive', effort: 'low' },
  triage: { model: HAIKU_MODEL, thinking: 'adaptive', effort: 'low' },
  screen: { model: HAIKU_MODEL, thinking: 'adaptive', effort: 'medium' },
  acknowledge: { model: HAIKU_MODEL, thinking: 'adaptive', effort: 'medium' },
  answer: { model: HAIKU_MODEL, thinking: 'adaptive', effort: 'medium' },
  speak: { model: HAIKU_MODEL, thinking: 'disabled', effort: 'medium' },
};

/** The set of valid task names — used by the skill loader to validate frontmatter. */
export const AGENT_TASKS = Object.keys(TASK_LANE) as AgentTask[];

/** Map a skill's declared task to the lane that should run it. */
export function pickLane(task: AgentTask): LaneConfig {
  const lane = TASK_LANE[task];
  if (!lane) {
    throw new Error(`pickLane: unknown task '${task}'`);
  }
  return lane;
}

/** Map a skill's declared task to the model tier that should run it. */
export function pickModel(task: AgentTask): ModelId {
  return pickLane(task).model;
}

/**
 * The lane, as the wire wants it.
 *
 * The pinned SDK (0.41.0) types neither `thinking`'s current shapes, nor
 * `output_config`, nor Gateway `providerOptions`; they are plain top-level body fields
 * needing no beta header, so this widens the request rather than waiting on a version
 * bump — the same tactic as `WireTool` in agent.ts.
 */
export interface LaneRequestFields {
  model: ModelId;
  thinking?: { type: 'adaptive' | 'disabled' | 'between_tools' };
  output_config?: { effort: Effort };
  providerOptions?: { gateway: { zeroDataRetention: true } };
}

export function laneRequestFields(lane: LaneConfig): LaneRequestFields {
  if (lane.model === DEEPSEEK_MODEL) {
    return {
      model: lane.model,
      thinking: { type: 'disabled' },
      providerOptions: { gateway: { zeroDataRetention: true } },
    };
  }
  return {
    model: lane.model,
    thinking: { type: lane.thinking },
    output_config: { effort: lane.effort },
  };
}

/**
 * Whether the model accepts a forced `tool_choice` (`tool` / `any`). Sonnet 5.5 and
 * Opus 5.5 return a 400 for both; Haiku 5.5 accepts them.
 */
export function acceptsForcedToolChoice(model: ModelId): boolean {
  return model === HAIKU_MODEL;
}

/**
 * The tool_choice that makes a single structured answer as close to guaranteed as the
 * model allows: the named tool where forcing is accepted, otherwise `auto` with at most
 * one call — and then the caller must check that the call happened (see forceToolJson).
 */
export function structuredToolChoice(
  model: ModelId,
  toolName: string,
): { type: 'tool'; name: string } | { type: 'auto'; disable_parallel_tool_use: true } {
  return acceptsForcedToolChoice(model)
    ? { type: 'tool', name: toolName }
    : { type: 'auto', disable_parallel_tool_use: true };
}

/**
 * The same lane with as little thinking as the tier allows.
 *
 * The re-ask shape for a step that spent its whole `max_tokens` thinking: on Haiku 5.5
 * that is `disabled` and on Sonnet 5.5 `between_tools`, the shapes on which the budget
 * cannot be spent reasoning (`xhigh` clamps to `high`, because both are a 400 above it).
 * Opus 5.5 cannot turn thinking off, so its least-thinking form is effort `low`. Null
 * when the lane is already there — a re-ask at the same shape buys the same completion
 * twice.
 */
export function withoutThinking(lane: LaneConfig): LaneConfig | null {
  if (lane.model === DEEPSEEK_MODEL || lane.thinking !== 'adaptive') return null;
  const effort = lane.effort === 'xhigh' ? 'high' : lane.effort;
  if (lane.model === HAIKU_MODEL) return { model: lane.model, thinking: 'disabled', effort };
  if (lane.model === SONNET_MODEL) {
    return { model: lane.model, thinking: 'between_tools', effort };
  }
  return lane.effort === 'low' ? null : { model: lane.model, thinking: 'adaptive', effort: 'low' };
}

/** Type guard: is `value` a known AgentTask? Lets the skill loader fail loudly on a typo. */
export function isAgentTask(value: string): value is AgentTask {
  return value in TASK_LANE;
}
