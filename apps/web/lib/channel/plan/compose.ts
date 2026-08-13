import { type AgentClient, pickModel } from '@hale/agent';
import type { FamilyStage } from '@hale/types';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { reachesForTheHealthLine } from '~/lib/channel/off-domain/copy';
import { smsEncoding, smsSegments } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { PlanTopic } from './topics';

/**
 * THE PLAN — step three, and the only place in this arc a model writes at length.
 *
 * Its shape is the general-answer composer's (lib/channel/off-domain/answer.ts), on
 * purpose and for the same three reasons: every degraded path comes back NAMED so the
 * caller can be honest (rule #11), the sendability checks are STRUCTURAL rather than
 * asked for in a prompt, and a body that reaches for the health line is SUBSTITUTED
 * rather than refused. What differs is only what a plan needs that an answer does not.
 *
 *   IT IS GROUNDED, where the general answer is deliberately blind. A plan is about one
 *   child at one age, so it gets the age, the companion content for that age, and a
 *   bounded set of things Hale already knows. Never the transcript, never the calendar,
 *   never a name: this stage writes advice, and nothing it could say is improved by
 *   knowing what the child is called (rule #1).
 *
 *   IT RETURNS A SEQUENCE, not a body. Two or three messages, each sendable on its own,
 *   because the thing a parent said yes to is an ordered plan and one 1,200-character
 *   text is not one.
 *
 *   IT IS THE EXPENSIVE TIER, where the answer is the cheapest. See the skill's
 *   frontmatter: this runs a handful of times per family per month behind an explicit
 *   YES, it has no hot path, and it produces the longest-lived thing Hale writes.
 *
 * PRIVACY. The question and the child's AGE go to the model. No name, no id, no
 * location, no schedule. Nothing here logs the question.
 */

/**
 * The ceiling on ONE plan message, in segments.
 *
 * Three, where a coach reply gets two. A reply interrupts; a plan was asked for twice,
 * and a stage of it that has been trimmed to two sentences is the amputation this whole
 * arc exists to undo. Three segments is ~459 GSM-7 characters — about the length of a
 * paragraph a parent reads standing up.
 */
export const MAX_PLAN_SEGMENTS = 3;

/** The plan is two or three messages. One is the answer they already had; four is a
 * document, and a document is what the app was for. */
export const MIN_PLAN_MESSAGES = 2;
export const MAX_PLAN_MESSAGES = 3;

/** Room for three messages plus the JSON around them. */
const MAX_TOKENS = 2048;

/**
 * A DOSE, structurally. Hale does not write these and the skill says so, but the skill
 * is a request: a number followed by a unit of medicine is the one shape whose cost is
 * a parent measuring something out on Hale's word, so it is refused in code.
 *
 * Deliberately narrow — a bare "5ml of water" in a solids plan would trip it, which is
 * the acceptable direction to be wrong in. It does not try to catch a named medicine or
 * a frequency, because a regex that tried would be a false promise; the eval's judge and
 * the skill carry that half.
 */
const DOSING_SHAPE = /\b\d+(?:\.\d+)?\s?(?:mg|ml|mcg|milligrams?|millilitres?|milliliters?)\b/i;

/** "No links, ever", held structurally: this stage has no tool a URL could come from,
 * so any URL in its output is one it invented. */
const LINK_SHAPE = /https?:\/\/|www\./i;

/**
 * Why the plan did not happen. Five separate stories, because they are five different
 * bugs: `client_unavailable` is configuration, `skill_unavailable` is a deploy,
 * `model_failed` is an outage, `unsendable` is the model writing something that must not
 * go on a wire, and `wrong_shape` is it returning the wrong number of messages.
 */
export type PlanFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unsendable'
  | 'wrong_shape';

export type PlanComposeOutcome =
  /** Ready to send, in order. */
  | { status: 'composed'; messages: string[] }
  /**
   * The plan reached for a phone number. Carries NO messages, deliberately: what a
   * parent gets in that moment is the reviewed line in off-domain/copy.ts, and a
   * variant with a text field is one a later edit could fill from the model.
   *
   * On a guidance topic this should be impossible — the parent asked how to do a thing,
   * not what to do about an emergency — so every one of these is worth counting.
   */
  | { status: 'safety' }
  | { status: 'unavailable'; reason: PlanFallback };

/** What the plan is written about. Assembled by the caller so this module reads no
 * tables and can be exercised without one. */
export interface PlanGrounding {
  topic: PlanTopic;
  /** The parent's own words. The real brief — `topic` is only the category. */
  question: string;
  /** The child the question was about, or null for a household question. */
  child: { ageMonths: number; stage: FamilyStage } | null;
  /** The Child Development & Wellbeing Companion's payload for that age — the same
   * object `get_framework_guidance` returns, passed through untouched. */
  guidance: unknown;
  /** A few things Hale already knows, bounded by the caller. Plain sentences. */
  facts: string[];
}

export interface PlanComposer {
  compose(grounding: PlanGrounding): Promise<PlanComposeOutcome>;
}

/**
 * THREE NAMED STRING FIELDS, not an array of them — and this is a correctness fix, not
 * a style choice.
 *
 * The first live recording of this stage came back with `messages` set to a JSON-encoded
 * STRING (`"[\"Nights 1-3: ...\", ...]"`) rather than a list. The plan inside it was
 * good; the shape was not, and `z.array(z.string())` would have rejected it as
 * `model_failed` — a parent who said yes getting an apology because the model chose a
 * different representation of the same content.
 *
 * A field typed `string` has no second representation to choose between, so the bug is
 * unexpressible rather than handled. The shape also carries the count: two required
 * fields and one optional IS the two-or-three rule, held by the schema instead of by a
 * check after the fact.
 *
 * Parsed loosely otherwise, for the reason screen.ts states at length: a strict schema
 * turns an injected field name into a logged ZodError (rule #1), and zod strips unknown
 * keys instead.
 */
const planSchema = z.object({
  first: z.string(),
  second: z.string(),
  third: z.string().optional(),
});

const planJsonSchema = {
  type: 'object',
  properties: {
    first: { type: 'string', description: 'The first plan message.' },
    second: { type: 'string', description: 'The second plan message.' },
    third: { type: 'string', description: 'The third plan message. Omit for a two-message plan.' },
  },
  required: ['first', 'second'],
} as const;

/** The plan's messages, in order, from the named fields the model fills. Exported
 * because the eval REPLICATES the request shape and must assemble it identically. */
export function planMessages(value: {
  first: string;
  second: string;
  third?: string;
}): string[] {
  return [value.first, value.second, ...(value.third === undefined ? [] : [value.third])];
}

/** The user-turn payload. Shared with the eval, which REPLICATES this request shape. */
export function planUserMessage(grounding: PlanGrounding): string {
  return JSON.stringify({
    topic: grounding.topic,
    question: grounding.question,
    child: grounding.child,
    guidance: grounding.guidance,
    facts: grounding.facts,
  });
}

/** The only thing any catch here may log: a provider error can carry the request back,
 * so the message survives and the object does not (rule #1). */
function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

function unavailable(reason: PlanFallback, detail?: string): PlanComposeOutcome {
  console.error({ reason, detail }, 'coach plan: could not compose a sendable plan');
  return { status: 'unavailable', reason };
}

/**
 * Every message, or none of them.
 *
 * ALL-OR-NOTHING is the design. A plan is a sequence, so dropping the message that
 * failed a gate would send a parent nights 1-3 and nights 8-14 with the middle missing
 * and nothing saying so — worse than the honest fallback, and impossible to notice from
 * the outside. One bad message fails the plan.
 */
export function sendablePlan(raw: readonly string[]): PlanComposeOutcome {
  const flattened = raw.map(plainText).filter((body) => body !== '');
  if (flattened.length < MIN_PLAN_MESSAGES || flattened.length > MAX_PLAN_MESSAGES) {
    return unavailable('wrong_shape', `${flattened.length} sendable messages`);
  }

  // Before every other gate, because this one SUBSTITUTES where the rest refuse: a
  // parent whose plan turned out to be about a hurt child must get the reviewed line,
  // never the "couldn't put that together" a refusal would send them.
  if (flattened.some(reachesForTheHealthLine)) {
    console.error('coach plan: composer reached for a referral; sent the fixed line');
    return { status: 'safety' };
  }

  for (const body of flattened) {
    if (smsSegments(body) > MAX_PLAN_SEGMENTS) return unavailable('unsendable', 'over_budget');
    if (smsEncoding(body) !== 'gsm7') return unavailable('unsendable', 'not_gsm7');
    if (LINK_SHAPE.test(body)) return unavailable('unsendable', 'carries_link');
    if (DOSING_SHAPE.test(body)) return unavailable('unsendable', 'carries_dosing');
  }
  return { status: 'composed', messages: flattened };
}

/**
 * The production composer.
 *
 * `client` is a RESOLVER for the reason the other two composers' are: the router builds
 * its dependencies for every inbound text, including the ones answered with no model at
 * all, so constructing a client at wiring time would make a missing key break approvals
 * — and deferring it buys the honest `client_unavailable` outcome.
 */
export function createPlanComposer(client: () => AgentClient): PlanComposer {
  return {
    async compose(grounding) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return unavailable('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('coach-plan');
      } catch (err) {
        return unavailable('skill_unavailable', message(err));
      }

      try {
        const { value } = await forceToolJson({
          client: resolved,
          model: pickModel(skill.meta.task),
          system: skill.instructions,
          userMessage: planUserMessage(grounding),
          toolName: 'plan',
          toolDescription:
            'Return the plan as two or three text messages, in order: first, second, and third only if the plan needs a third stage.',
          inputJsonSchema: planJsonSchema,
          schema: planSchema,
          maxTokens: MAX_TOKENS,
        });
        return sendablePlan(planMessages(value));
      } catch (err) {
        return unavailable('model_failed', message(err));
      }
    },
  };
}
