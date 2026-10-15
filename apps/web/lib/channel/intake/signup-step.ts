import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * WHETHER A MID-SIGNUP TEXT ANSWERS THE OPEN STEP.
 *
 * A model reads the reply. There is no word list and no fixed sentence. The
 * open step comes from the session, never from the words. A message that does
 * not answer it is handed to the coach, which replies in the language the
 * parent wrote in.
 *
 * A missing client, a missing skill, or a model failure is unreadable, and the
 * log names which. The parent's text is never in that line (rule #1, rule #11).
 * The caller treats unreadable the same as "not an answer": the coach, not an
 * English script.
 */

export type SignupStep = 'names' | 'signup' | 'calendar' | 'email';

export interface SignupStepReading {
  answers: boolean;
}

export interface SignupStepReader {
  read(input: { step: SignupStep; text: string }): Promise<SignupStepReading | null>;
}

/** One SMS body cannot exceed this by the time it reaches us. */
const MAX_TEXT_CHARS = 1600;

export const SIGNUP_STEP_REPLY_MAX_TOKENS = 256;

export const SIGNUP_STEP_REPLY_TOOL = 'signup_step_reply';

export const signupStepReplySchema = z.object({
  answers: z.boolean(),
  reason: z.string().optional(),
});

export const SIGNUP_STEP_REPLY_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    answers: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['answers'],
} as const;

/** The user-turn payload. Shared with the eval, which replicates this request shape. */
export function signupStepReplyUserMessage(input: { step: SignupStep; text: string }): string {
  return JSON.stringify({ step: input.step, text: input.text });
}

/**
 * The question Hale is waiting on. Names until the sign-up offer has gone out,
 * then that offer, then calendar, then email.
 */
export function openSignupStep(progress: {
  signupAsked: boolean;
  calendarAsked: boolean;
  emailAsked: boolean;
}): SignupStep {
  if (!progress.signupAsked) return 'names';
  if (!progress.calendarAsked) return 'signup';
  if (!progress.emailAsked) return 'calendar';
  return 'email';
}

export function toSignupStepReading(raw: { answers?: unknown }): SignupStepReading | null {
  if (typeof raw.answers !== 'boolean') return null;
  return { answers: raw.answers };
}

function message(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function unreadable(reason: string, detail?: string): null {
  console.info({ reason, detail }, 'signup step reply: unreadable');
  return null;
}

/**
 * `client` is a resolver, not a value. These deps are built for every inbound
 * text, including the ones a deterministic handler answers with no model at
 * all, so a missing key must not throw. It is unreadable, named in the log.
 */
export function createSignupStepReader(client: () => AgentClient): SignupStepReader {
  return {
    async read(input) {
      const bounded = input.text.slice(0, MAX_TEXT_CHARS);
      let resolved: AgentClient;
      try {
        resolved = client();
      } catch (err) {
        return unreadable('client_unavailable', message(err));
      }

      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('signup-step-reply');
      } catch (err) {
        return unreadable('skill_unavailable', message(err));
      }

      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: signupStepReplyUserMessage({ step: input.step, text: bounded }),
          toolName: SIGNUP_STEP_REPLY_TOOL,
          toolDescription: 'Decide whether this message answers the open signup step.',
          inputJsonSchema: SIGNUP_STEP_REPLY_TOOL_SCHEMA,
          schema: signupStepReplySchema,
          maxTokens: SIGNUP_STEP_REPLY_MAX_TOKENS,
        });
        const reading = toSignupStepReading(value);
        if (!reading) return unreadable('unreadable');
        return reading;
      } catch (err) {
        return unreadable('model_failed', message(err));
      }
    },
  };
}
