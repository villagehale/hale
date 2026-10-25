import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { SignupOffer } from './types';

/**
 * WHETHER THE PARENT SAID TO SIGN UP (T8 / VIL-453).
 *
 * A model reads the message beside the pending offer and its sessions. There
 * is no word list. Only an explicit go-ahead is consent; a hedge or a question
 * about the offer comes back as `unclear` with one clarifying question.
 *
 * A missing client, a missing skill, a model failure or an unreadable result
 * is null, and the log names which. The caller treats null as no consent: it
 * does not claim the message and opens no browser.
 */

export type SignupConsentReading =
  | { verdict: 'consent'; sessionId: string | null }
  | { verdict: 'decline' }
  | { verdict: 'unclear'; question: string }
  | { verdict: 'unrelated' };

export interface SignupConsentReader {
  read(input: { text: string; offer: SignupOffer }): Promise<SignupConsentReading | null>;
}

const MAX_TEXT_CHARS = 1600;
const MAX_QUESTION_CHARS = 320;
export const SIGNUP_CONSENT_MAX_TOKENS = 300;
export const SIGNUP_CONSENT_TOOL = 'signup_consent';

const VERDICTS = ['consent', 'decline', 'unclear', 'unrelated'] as const;

export const signupConsentSchema = z.object({
  verdict: z.enum(VERDICTS),
  sessionId: z.string().nullable(),
  question: z.string().nullable(),
  reason: z.string().optional(),
});

export const SIGNUP_CONSENT_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: [...VERDICTS] },
    sessionId: { type: ['string', 'null'] },
    question: { type: ['string', 'null'] },
    reason: { type: 'string' },
  },
  required: ['verdict', 'sessionId', 'question'],
} as const;

/** The user turn: the offer the parent is answering, then their words. No child data. */
export function signupConsentUserMessage(input: { text: string; offer: SignupOffer }): string {
  return JSON.stringify({
    offer: {
      activityKey: input.offer.activityKey,
      registrationUrl: input.offer.registrationUrl,
      approvedPriceCents: input.offer.approvedPriceCents,
      sessions: input.offer.sessions.map((session) => ({
        id: session.id,
        label: session.label,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        full: session.full,
        priceCents: session.priceCents,
      })),
    },
    text: input.text.slice(0, MAX_TEXT_CHARS),
  });
}

const LINK = /https?:\/\/|www\./i;

/**
 * Structural checks only. A consent naming a session outside the offer is not
 * consent to anything, so it becomes `unclear` and is never booked.
 */
export function toSignupConsentReading(
  raw: z.infer<typeof signupConsentSchema>,
  offer: SignupOffer,
): SignupConsentReading | null {
  if (raw.verdict === 'consent') {
    if (raw.sessionId === null) return { verdict: 'consent', sessionId: null };
    if (offer.sessions.some((session) => session.id === raw.sessionId)) {
      return { verdict: 'consent', sessionId: raw.sessionId };
    }
    const question = cleanQuestion(raw.question);
    return question ? { verdict: 'unclear', question } : null;
  }
  if (raw.verdict === 'unclear') {
    const question = cleanQuestion(raw.question);
    return question ? { verdict: 'unclear', question } : null;
  }
  return { verdict: raw.verdict };
}

function cleanQuestion(value: string | null): string | null {
  const text = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text || text.length > MAX_QUESTION_CHARS || LINK.test(text)) return null;
  return text;
}

function message(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function unreadable(reason: string, detail?: string): null {
  console.info({ reason, detail }, 'signup consent: unreadable');
  return null;
}

/** `client` is a resolver: a missing key is unreadable, never a throw. */
export function createSignupConsentReader(
  client: () => AgentClient | null | Promise<AgentClient | null>,
): SignupConsentReader {
  return {
    async read(input) {
      if (!input.text.trim()) return null;
      let resolved: AgentClient | null;
      try {
        resolved = await client();
      } catch (err) {
        return unreadable('client_unavailable', message(err));
      }
      if (!resolved) return unreadable('client_unavailable');
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('signup-consent');
      } catch (err) {
        return unreadable('skill_unavailable', message(err));
      }
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: signupConsentUserMessage(input),
          toolName: SIGNUP_CONSENT_TOOL,
          toolDescription: 'Decide whether the parent explicitly said to sign up for this offer.',
          inputJsonSchema: SIGNUP_CONSENT_TOOL_SCHEMA,
          schema: signupConsentSchema,
          maxTokens: SIGNUP_CONSENT_MAX_TOKENS,
        });
        return toSignupConsentReading(value, input.offer) ?? unreadable('unreadable');
      } catch (err) {
        return unreadable('model_failed', message(err));
      }
    },
  };
}
