import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape, withoutLinks } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { SignupSession } from '../types';
import { MAX_PLAN_CHOICES } from './store';

/**
 * VIL-558 · WHETHER THE PARENT APPROVED THE PLAN, OR TOOK IT BACK.
 *
 * A model reads the message beside the plan Hale offered (or the one the parent already
 * approved). There is no word list. The answer is a strict schema; code then checks every
 * id against the offer's own sessions, so a reading can only name sessions Hale saw.
 *
 * A missing client, a missing skill, a model failure or an unreadable result is null, and
 * the log names which. The caller treats null as no plan: it claims nothing.
 */

export interface PlanReadOffer {
  status: 'pending' | 'planned';
  opensAt: Date;
  sessions: readonly SignupSession[];
  approvedPriceCents: number | null;
  plan: { choiceIds: readonly string[]; maxPriceCents: number; waiverAccepted: boolean } | null;
}

export type PlanReading =
  | { verdict: 'approve'; choiceIds: string[]; maxPriceCents: number; waiverAccepted: boolean }
  | { verdict: 'take_back' }
  | { verdict: 'unclear'; question: string }
  | { verdict: 'unrelated' };

export interface PlanReader {
  read(input: { text: string; offer: PlanReadOffer }): Promise<PlanReading | null>;
}

const MAX_TEXT_CHARS = 1600;
const MAX_QUESTION_CHARS = 320;
export const SIGNUP_PLAN_READ_SKILL = 'signup-plan-read';
export const SIGNUP_PLAN_READ_TOOL = 'signup_plan_read';
export const SIGNUP_PLAN_READ_TOOL_DESCRIPTION =
  'Decide whether the parent approved the registration plan, took it back, or neither.';
export const SIGNUP_PLAN_READ_MAX_TOKENS = 2048;

const VERDICTS = ['approve', 'take_back', 'unclear', 'unrelated'] as const;

export const signupPlanReadSchema = z
  .object({
    reason: z.string(),
    verdict: z.enum(VERDICTS),
    choiceIds: z.array(z.string()),
    maxPriceCents: z.number().int().nullable(),
    waiverAccepted: z.boolean(),
    question: z.string().nullable(),
  })
  .strict();

export const SIGNUP_PLAN_READ_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    verdict: { type: 'string', enum: [...VERDICTS] },
    choiceIds: { type: 'array', items: { type: 'string' } },
    maxPriceCents: { type: ['integer', 'null'] },
    waiverAccepted: { type: 'boolean' },
    question: { type: ['string', 'null'] },
  },
  required: ['reason', 'verdict', 'choiceIds', 'maxPriceCents', 'waiverAccepted', 'question'],
  additionalProperties: false,
} as const;

/** The user turn: the plan the parent is answering, then their words. No child data. */
export function signupPlanReadUserMessage(input: { text: string; offer: PlanReadOffer }): string {
  return JSON.stringify({
    offer: {
      status: input.offer.status,
      opensAt: input.offer.opensAt.toISOString(),
      approvedPriceCents: input.offer.approvedPriceCents,
      sessions: input.offer.sessions.map((session) => ({
        id: session.id,
        label: withoutLinks(session.label),
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        full: session.full,
        priceCents: session.priceCents,
      })),
      plan: input.offer.plan,
    },
    text: input.text.slice(0, MAX_TEXT_CHARS),
  });
}

function cleanQuestion(value: string | null): string | null {
  const text = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!text || text.length > MAX_QUESTION_CHARS || hasLinkShape(text)) return null;
  return text;
}

/**
 * Structural checks only. An approval of a plan already approved changes nothing. An
 * approval naming a session outside the offer, repeating one, or with no usable price is
 * not an approval of anything: it becomes `unclear` when the model gave a question, and
 * unreadable otherwise.
 */
export function toPlanReading(
  raw: z.infer<typeof signupPlanReadSchema>,
  offer: PlanReadOffer,
): PlanReading | null {
  if (raw.verdict === 'take_back') return { verdict: 'take_back' };
  if (raw.verdict === 'unrelated') return { verdict: 'unrelated' };
  if (raw.verdict === 'unclear') {
    const question = cleanQuestion(raw.question);
    return question ? { verdict: 'unclear', question } : null;
  }
  if (offer.status === 'planned') return { verdict: 'unrelated' };
  const ids = raw.choiceIds;
  const known = new Set(offer.sessions.map((session) => session.id));
  const valid =
    ids.length > 0 &&
    ids.length <= MAX_PLAN_CHOICES &&
    new Set(ids).size === ids.length &&
    ids.every((id) => known.has(id)) &&
    raw.maxPriceCents !== null &&
    raw.maxPriceCents > 0;
  if (valid && raw.maxPriceCents !== null) {
    return {
      verdict: 'approve',
      choiceIds: [...ids],
      maxPriceCents: raw.maxPriceCents,
      waiverAccepted: raw.waiverAccepted,
    };
  }
  const question = cleanQuestion(raw.question);
  return question ? { verdict: 'unclear', question } : null;
}

function className(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function unreadable(reason: string, detail?: string): null {
  console.info({ reason, detail }, 'signup plan read: unreadable');
  return null;
}

/** `client` is a resolver: a missing key is unreadable, never a throw. */
export function createPlanReader(
  client: () => AgentClient | null | Promise<AgentClient | null>,
): PlanReader {
  return {
    async read(input) {
      if (!input.text.trim()) return null;
      let resolved: AgentClient | null;
      try {
        resolved = await client();
      } catch (err) {
        return unreadable('client_unavailable', className(err));
      }
      if (!resolved) return unreadable('client_unavailable');
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill(SIGNUP_PLAN_READ_SKILL);
      } catch (err) {
        return unreadable('skill_unavailable', className(err));
      }
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: signupPlanReadUserMessage(input),
          toolName: SIGNUP_PLAN_READ_TOOL,
          toolDescription: SIGNUP_PLAN_READ_TOOL_DESCRIPTION,
          inputJsonSchema: SIGNUP_PLAN_READ_TOOL_SCHEMA,
          schema: signupPlanReadSchema,
          maxTokens: SIGNUP_PLAN_READ_MAX_TOKENS,
        });
        return toPlanReading(value, input.offer) ?? unreadable('unreadable');
      } catch (err) {
        return unreadable('model_failed', className(err));
      }
    },
  };
}
