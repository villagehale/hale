/**
 * Single source of truth for model ids + the task → LANE routing.
 *
 * Before this package, model ids lived in apps/worker/src/anthropic/client.ts
 * and apps/web/lib/coach/model.ts read them back across the process boundary.
 * Both should import HAIKU_MODEL / SONNET5_MODEL / OPUS_MODEL from here instead,
 * so a model bump is one edit, not a readFileSync-parse that can silently drift.
 */

export const HAIKU_MODEL = 'claude-haiku-4-5';
/**
 * The 4.6 tier: the eval judge, the middle rung of run-model-matrix-eval's ladder,
 * and — until they migrate — the `draft` and `infer` lanes (see TASK_LANE).
 *
 * Kept at 4.6 deliberately through the Sonnet-5 re-tier. Moving the judge in the
 * same change that moves the subject would re-grade every fixture against a
 * different marker, so a regression and a re-calibration would be
 * indistinguishable — and it would needlessly invalidate every cached judge
 * verdict. No suite both judges with this tier and runs its subject on it.
 * Change this only to deliberately re-baseline grading.
 */
export const SONNET_MODEL = 'claude-sonnet-4-6';
export const SONNET5_MODEL = 'claude-sonnet-5';
export const OPUS_MODEL = 'claude-opus-5';

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
 *  - classify / review / extract → Sonnet 5  (eval-proven; classify and extract both
 *    carry teen_content — a rule-#1 safety call, gated on teenAccuracy in the model
 *    matrix)
 *  - converse / draft / infer / discover → Sonnet 5
 *  - high-stakes-judgment → Opus 5  (run-rarely, judgment-dense)
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
 * The union is the point. Two shapes are 400s at the API and both are now
 * unrepresentable rather than merely discouraged (each verified against the live
 * API, 2026-08-21):
 *
 *  - Haiku 4.5 accepts NEITHER knob — `output_config.effort` returns "This model
 *    does not support the effort parameter" and `thinking` returns "adaptive
 *    thinking is not supported on this model". The Haiku arm therefore has no
 *    knob fields at all, so a well-meant `effort: 'low'` on the phone-call lane
 *    is a compile error instead of a 400 mid-call.
 *  - `thinking: 'disabled'` with `effort: 'xhigh'` returns "output_config.effort
 *    'xhigh' is not supported when thinking is disabled on this model" (Opus 5).
 *    The disabled arm therefore stops at `high`.
 *
 * Thinking is spelled out on every reasoning lane rather than left to the model
 * default, because the default flipped underneath us: on Sonnet 4.6 an omitted
 * `thinking` meant no thinking, on Sonnet 5 and Opus 5 it means adaptive. Since
 * `max_tokens` caps thinking AND reply text together, inheriting that default on
 * a lane budgeted at 128 tokens is how a reply silently truncates. Naming it per
 * lane makes the choice reviewable.
 */
export type LaneConfig =
  | { model: typeof HAIKU_MODEL }
  | { model: ReasoningModelId; thinking: 'adaptive'; effort: Effort }
  | { model: ReasoningModelId; thinking: 'disabled'; effort: Exclude<Effort, 'xhigh'> };

/** The tiers that accept the reasoning knobs — everything except Haiku. */
export type ReasoningModelId = typeof SONNET_MODEL | typeof SONNET5_MODEL | typeof OPUS_MODEL;

/**
 * The lane matrix.
 *
 * `effort` is set explicitly on every reasoning lane because the API default is
 * `high`, which is the wrong default for a parent watching three dots. The
 * classify / review / extract lanes keep `adaptive` + `high` — the API's own
 * defaults written out, so their wire behaviour is unchanged by this table while
 * still being stated rather than inherited. They carry teen_content (rule #1) and
 * are not re-tuned here.
 */
const TASK_LANE: Record<AgentTask, LaneConfig> = {
  // Rule-#1 safety lanes: the API defaults, made explicit. Do not re-tune without
  // re-running the teenAccuracy gate.
  classify: { model: SONNET5_MODEL, thinking: 'adaptive', effort: 'high' },
  review: { model: SONNET5_MODEL, thinking: 'adaptive', effort: 'high' },
  extract: { model: SONNET5_MODEL, thinking: 'adaptive', effort: 'high' },

  // The inline chat lane, and the one place the doctrine's `low` turned out to be
  // wrong. Effort governs how readily Sonnet 5 reaches for a tool, and on the
  // flagship both-halves fixture (a verified registration date AND a live web find
  // in one reply) it silently stopped calling find_activities: measured live n=3
  // per level, `low` called it 0/3, `medium` 2/3, `high` 3/3. A parent then gets
  // the date and never the thing they can do before it — the exact regression #522
  // exists to prevent — with no error anywhere. `high` is therefore the floor here,
  // not a tuning preference.
  converse: { model: SONNET5_MODEL, thinking: 'adaptive', effort: 'high' },

  discover: { model: SONNET5_MODEL, thinking: 'adaptive', effort: 'medium' },

  // PENDING MIGRATION — held on 4.6 with the knobs set to reproduce exactly what
  // that model did before the re-tier (an omitted `thinking` is no thinking on 4.6,
  // and `high` is the API default; verified live, 0 thinking blocks either way).
  //
  // Sonnet 5 is a quality REGRESSION on these two lanes, and it is not a knob
  // problem: drafter, identity-ask, intro-voice, radar, reminder-voice and memory
  // were re-recorded live at effort medium AND high AND with thinking disabled, and
  // failed under all three. Two distinct causes, both needing work this change
  // deliberately does not do:
  //   - drafter ships `payload: {type:'object', additionalProperties:true}`, an
  //     unconstrained node with no grammar. 4.6 filled it with an object; Sonnet 5
  //     fills it with a stringified JSON blob that duplicates the envelope, so
  //     to/subject/body all read empty — on emails to real recipients.
  //   - the short-copy lanes collapse to one template: two different reminders
  //     produced a byte-identical line (similarity 1.00 against a 0.75 ceiling) and
  //     all four intro asks opened the same way (1 distinct opener, 2 required).
  // Move these once the payload schema is constrained and the skills get a variety
  // pass — not by loosening either grader.
  draft: { model: SONNET_MODEL, thinking: 'disabled', effort: 'high' },
  infer: { model: SONNET_MODEL, thinking: 'disabled', effort: 'high' },

  // Run-rarely and judgment-dense: the one lane worth `xhigh`.
  'high-stakes-judgment': { model: OPUS_MODEL, thinking: 'adaptive', effort: 'xhigh' },

  // Haiku lanes — no knob exists on this tier (see LaneConfig).
  'simple-lookup': { model: HAIKU_MODEL },
  triage: { model: HAIKU_MODEL },
  acknowledge: { model: HAIKU_MODEL },
  screen: { model: HAIKU_MODEL },
  answer: { model: HAIKU_MODEL },
  speak: { model: HAIKU_MODEL },
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
 * The pinned SDK (0.41.0) types neither `thinking` nor `output_config`; both are
 * plain top-level body fields needing no beta header, so this widens the request
 * rather than waiting on a version bump — the same tactic as `WireTool` in
 * agent.ts. A Haiku lane spreads to `{ model }` alone, which is the only shape
 * that tier accepts.
 */
export interface LaneRequestFields {
  model: ModelId;
  thinking?: { type: 'adaptive' | 'disabled' };
  output_config?: { effort: Effort };
}

export function laneRequestFields(lane: LaneConfig): LaneRequestFields {
  if (!('thinking' in lane)) {
    return { model: lane.model };
  }
  return {
    model: lane.model,
    thinking: { type: lane.thinking },
    output_config: { effort: lane.effort },
  };
}

/** Type guard: is `value` a known AgentTask? Lets the skill loader fail loudly on a typo. */
export function isAgentTask(value: string): value is AgentTask {
  return value in TASK_LANE;
}
