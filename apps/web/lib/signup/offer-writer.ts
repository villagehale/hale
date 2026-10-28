import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { SignupSession } from './types';

/**
 * THE TEXT THAT OFFERS A REGISTRATION (VIL-470).
 *
 * Hale's AI writes it from facts Hale actually saw. There is no fixed sentence
 * here, and nothing falls back to offer-copy.ts. A draft that drops the
 * registration URL, adds another one, or leaves out every session Hale saw
 * does not send.
 *
 * A missing client, skill, or a failed draft returns null and names why.
 */

export const SIGNUP_OFFER_SOURCES = ['email', 'calendar', 'flyer', 'chat'] as const;
export type SignupOfferSource = (typeof SIGNUP_OFFER_SOURCES)[number];

export interface SignupOfferFacts {
  source: SignupOfferSource;
  /** What Hale saw, already extracted. Never a template. */
  evidence: string;
  registrationUrl: string;
  sessions: readonly SignupSession[];
  approvedPriceCents: number | null;
  /** Set only for a child under 13. The writer may use it; it is not required. */
  childFirstName: string | null;
  language: string | null;
}

export interface SignupOfferWriter {
  write(facts: SignupOfferFacts): Promise<string | null>;
}

const MAX_CHARS = 480;
export const SIGNUP_OFFER_MAX_TOKENS = 300;
export const SIGNUP_OFFER_TOOL = 'signup_offer';
export const signupOfferSchema = z.object({ text: z.string() });
export const SIGNUP_OFFER_TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

const URL_PATTERN = /https?:\/\/[^\s)]+/gi;

/** Why a draft cannot leave. Empty means it can. */
export function signupOfferViolations(text: string, facts: SignupOfferFacts): string[] {
  const out: string[] = [];
  const tidy = text.trim();
  if (!tidy) out.push('empty');
  if (tidy.length > MAX_CHARS) out.push('too long');
  const urls = tidy.match(URL_PATTERN) ?? [];
  if (!tidy.includes(facts.registrationUrl)) out.push('missing the registration link');
  if (urls.some((url) => !facts.registrationUrl.startsWith(url) && !url.startsWith(facts.registrationUrl))) {
    out.push('contains another link');
  }
  const grounded = facts.sessions.some((session) => tidy.includes(session.label));
  if (!grounded) out.push('missing a session Hale saw');
  return out;
}

export function signupOfferUserMessage(facts: SignupOfferFacts): string {
  return JSON.stringify({
    facts: {
      source: facts.source,
      evidence: facts.evidence.slice(0, 1600),
      registrationUrl: facts.registrationUrl,
      sessions: facts.sessions.map((session) => ({
        id: session.id,
        label: session.label,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        full: session.full,
        priceCents: session.priceCents,
      })),
      approvedPriceCents: facts.approvedPriceCents,
      childFirstName: facts.childFirstName,
      language: facts.language,
    },
  });
}

function unwritten(reason: string, detail?: string): null {
  console.info({ reason, detail }, 'signup offer: not sent');
  return null;
}

function className(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

/** `client` is a resolver: a missing key is unwritten, never a throw. */
export function createSignupOfferWriter(
  client: () => AgentClient | null | Promise<AgentClient | null>,
): SignupOfferWriter {
  return {
    async write(facts) {
      if (!facts.evidence.trim()) return unwritten('no_facts');
      if (facts.sessions.length === 0) return unwritten('no_facts');
      let resolved: AgentClient | null;
      try {
        resolved = await client();
      } catch (err) {
        return unwritten('client_unavailable', className(err));
      }
      if (!resolved) return unwritten('client_unavailable');
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('signup-offer');
      } catch (err) {
        return unwritten('skill_unavailable', className(err));
      }
      let note: string | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: JSON.stringify({
              facts: JSON.parse(signupOfferUserMessage(facts)).facts,
              violation: note,
            }),
            toolName: SIGNUP_OFFER_TOOL,
            toolDescription: 'Write the one text that offers this registration.',
            inputJsonSchema: SIGNUP_OFFER_TOOL_SCHEMA,
            schema: signupOfferSchema,
            maxTokens: SIGNUP_OFFER_MAX_TOKENS,
          });
          const violations = signupOfferViolations(value.text, facts);
          if (violations.length === 0) return value.text.replace(/\s+/g, ' ').trim();
          note = violations.join('; ');
        } catch (err) {
          return unwritten('model_failed', className(err));
        }
      }
      return unwritten('violations', note ?? '');
    },
  };
}
