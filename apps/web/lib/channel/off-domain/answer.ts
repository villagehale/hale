import { type AgentClient, pickModel } from '@hale/agent';
import { z } from 'zod';
import { plainText } from '~/lib/channel/coach/reply';
import { smsEncoding } from '~/lib/channel/sms-segments';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * Boundary v3 — the general answer.
 *
 * The quiet-operator promise governs OUTBOUND: Hale never starts the chatter. INBOUND it
 * was over-applied. A parent who texted "who's the goat in football" got charm and a
 * closed door, and a closed door to a question a friend would just answer reads as a
 * product that cannot, not one that chooses not to. So the `off_domain_general` terminal
 * flips: one good, honest, brief answer, and then done. The other two doors do not move
 * — a symptom still gets 811 and a parent hunting a paediatrician still gets Health Care
 * Connect, both from fixed copy no model touches (see copy.ts).
 *
 * Three properties keep this cheap and safe to put on the hot path:
 *
 *   IT IS BLIND, DELIBERATELY. The model sees the question and NOTHING else. No family,
 *   no children, no calendar, no transcript — none of it is even loaded. That is rule #1
 *   at its cheapest (a trivia answer needs nothing about the kids, so nothing about the
 *   kids is at risk), and it is also why this stage costs a fraction of a coach turn:
 *   there is no context to assemble and no tool loop to run.
 *
 *   IT HAS NO TOOLS AND NO LIVE DATA. Which makes "the weather tomorrow" an honesty
 *   test rather than a lookup, and the skill answers it as one.
 *
 *   IT CANNOT COST A PARENT THEIR REPLY. Every degraded path — no client, no skill, an
 *   outage, an answer that cannot be sent — comes back NAMED (rule #11) and the lane
 *   sends the fixed deflect line instead. The parent always gets something.
 *
 * PRIVACY. The question goes to the model (as it already did to the screen one call
 * earlier) and nowhere else. Nothing here logs it.
 */

/**
 * The hard ceiling on what goes out, in characters.
 *
 * 300 GSM-7 characters is two SMS segments (153 each) — the same budget the coach's own
 * replies are fitted to, and about two sentences, which is what the skill asks for. It
 * is stated in the skill too, and the eval gates on it: a model told a number and then
 * measured against it is the only version of this that stays true.
 */
export const MAX_ANSWER_CHARS = 300;

const MAX_TOKENS = 256;

/**
 * Why the answer did not happen. Deliberately four separate stories and not one:
 * `client_unavailable` is configuration, `skill_unavailable` is a deploy bug,
 * `model_failed` is an outage, and `unsendable` is the model itself writing something
 * that must not go on the wire. Only the last one is a prompt problem.
 */
export type GeneralAnswerFallback =
  | 'client_unavailable'
  | 'skill_unavailable'
  | 'model_failed'
  | 'unsendable';

export type GeneralAnswerOutcome =
  | { status: 'composed'; reply: string }
  | { status: 'unavailable'; reason: GeneralAnswerFallback };

export interface GeneralAnswerComposer {
  compose(text: string): Promise<GeneralAnswerOutcome>;
}

/** Parsed loosely, for the reason screen.ts states at length: a strict schema turns a
 * parent's injected field name into a logged ZodError message (rule #1), and zod's
 * default strips unknown keys instead. */
const answerSchema = z.object({ answer: z.string() });

const answerJsonSchema = {
  type: 'object',
  properties: { answer: { type: 'string' } },
  required: ['answer'],
} as const;

/** The user-turn payload. Shared with the eval, which REPLICATES this request shape. */
export function generalAnswerUserMessage(text: string): string {
  return JSON.stringify({ text });
}

/** The only thing any catch here may log: a provider error can carry the request back,
 * so the message survives and the object does not (rule #1). */
function message(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown';
}

function unavailable(reason: GeneralAnswerFallback, detail?: string): GeneralAnswerOutcome {
  console.error({ reason, detail }, 'off-domain answer: falling back to the fixed line');
  return { status: 'unavailable', reason };
}

/**
 * The composed answer, or a named reason it cannot be sent.
 *
 * The cap is a REFUSAL rather than a trim. The coach can trim, because it has an app
 * link to hand the remainder to; this stage has nothing to point at and nothing worth
 * pointing at, so an answer cut mid-clause would just be a worse message than the fixed
 * line it would have replaced. `detail` separates the three ways a body can be
 * unsendable in the LOG without splitting the outcome the caller acts on — every one of
 * them means the same thing to the lane.
 */
function sendable(raw: string): GeneralAnswerOutcome {
  const flattened = plainText(raw);
  if (flattened === '') return unavailable('unsendable', 'empty');
  if (flattened.length > MAX_ANSWER_CHARS) return unavailable('unsendable', 'over_char_cap');
  if (smsEncoding(flattened) !== 'gsm7') return unavailable('unsendable', 'not_gsm7');
  return { status: 'composed', reply: flattened };
}

/**
 * The production composer.
 *
 * `client` is a RESOLVER for the same reason the screen's is: the router builds its
 * dependencies for every inbound text including the ones a deterministic handler answers
 * with no model at all, so constructing a client at wiring time would make a missing key
 * break approvals — and deferring it buys the honest `client_unavailable` outcome.
 */
export function createGeneralAnswer(client: () => AgentClient): GeneralAnswerComposer {
  return {
    async compose(text) {
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return unavailable('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('general-answer');
      } catch (err) {
        return unavailable('skill_unavailable', message(err));
      }

      try {
        const { value } = await forceToolJson({
          client: resolved,
          model: pickModel(skill.meta.task),
          system: skill.instructions,
          userMessage: generalAnswerUserMessage(text),
          toolName: 'answer',
          toolDescription: 'Return the one brief answer to this question.',
          inputJsonSchema: answerJsonSchema,
          schema: answerSchema,
          maxTokens: MAX_TOKENS,
        });
        return sendable(value.answer);
      } catch (err) {
        return unavailable('model_failed', message(err));
      }
    },
  };
}
