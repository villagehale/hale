import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape, withoutLinks } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import { quotesParent } from '../parent-quote';
import type { SignupSession } from '../types';
import { MAX_PLAN_CHOICES } from './store';

/**
 * VIL-558 · WHETHER THE PARENT APPROVED THE PLAN, OR TOOK IT BACK.
 *
 * A model reads the message beside the plan Hale offered (or the one the parent already
 * approved). There is no word list. The answer is a strict schema; code then checks every
 * id against the offer's own sessions, so a reading can only name sessions Hale saw.
 *
 * The offer's activity name came from a web page or the coach model, so it is untrusted:
 * it reaches the model marked as such, cleaned and cut short, and nothing in it can carry
 * an approval. An approval holds only on the parent's own words, copied (`said`); its
 * maximum only on a price Hale stored for what they chose or an amount they wrote; the
 * waiver only on their own words (`waiverSaid`). Anything else fails closed.
 *
 * A missing client, a missing skill, a model failure or an unreadable result is null, and
 * the log names which. The caller treats null as no plan: it claims nothing.
 */

export interface PlanReadOffer {
  status: 'pending' | 'planned';
  /**
   * The program's public name, or null for an offer recorded before names were kept.
   * Untrusted: a page or the coach model wrote it ({@link untrustedActivityLabel}).
   */
  activity: string | null;
  /** The registration site's host. */
  host: string;
  opensAt: Date;
  sessions: readonly SignupSession[];
  approvedPriceCents: number | null;
  plan: { choiceIds: readonly string[]; maxPriceCents: number; waiverAccepted: boolean } | null;
}

/**
 * `named`: the parent's own words name this plan's program or site, checked against their
 * message. A plan other than the newest is only ever moved on words that name it.
 */
export type PlanReading =
  | {
      verdict: 'approve';
      choiceIds: string[];
      maxPriceCents: number;
      waiverAccepted: boolean;
      named: boolean;
    }
  | { verdict: 'take_back'; named: boolean }
  | { verdict: 'unclear'; question: string }
  | { verdict: 'unrelated' };

export interface PlanReader {
  read(input: { text: string; offer: PlanReadOffer }): Promise<PlanReading | null>;
}

const MAX_TEXT_CHARS = 1600;
const MAX_QUESTION_CHARS = 320;
/** A program's name, not a paragraph: the longest activity label a reader is shown. */
export const MAX_ACTIVITY_LABEL_CHARS = 80;
export const SIGNUP_PLAN_READ_SKILL = 'signup-plan-read';
export const SIGNUP_PLAN_READ_TOOL = 'signup_plan_read';
export const SIGNUP_PLAN_READ_TOOL_DESCRIPTION =
  'Decide whether the parent approved the registration plan, took it back, or neither.';
export const SIGNUP_PLAN_READ_MAX_TOKENS = 2048;

const VERDICTS = ['approve', 'take_back', 'unclear', 'unrelated'] as const;

export const signupPlanReadSchema = z
  .object({
    reason: z.string(),
    said: z.string().nullable(),
    named: z.string().nullable(),
    verdict: z.enum(VERDICTS),
    choiceIds: z.array(z.string()),
    maxPriceCents: z.number().int().nullable(),
    waiverSaid: z.string().nullable(),
    waiverAccepted: z.boolean(),
    question: z.string().nullable(),
  })
  .strict();

export const SIGNUP_PLAN_READ_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    said: { type: ['string', 'null'] },
    named: { type: ['string', 'null'] },
    verdict: { type: 'string', enum: [...VERDICTS] },
    choiceIds: { type: 'array', items: { type: 'string' } },
    maxPriceCents: { type: ['integer', 'null'] },
    waiverSaid: { type: ['string', 'null'] },
    waiverAccepted: { type: 'boolean' },
    question: { type: ['string', 'null'] },
  },
  required: [
    'reason',
    'said',
    'named',
    'verdict',
    'choiceIds',
    'maxPriceCents',
    'waiverSaid',
    'waiverAccepted',
    'question',
  ],
  additionalProperties: false,
} as const;

/**
 * An offer's activity name as a reader may see it. A page or the coach model wrote it, so
 * control and invisible characters go (an invisible one could hide a host from the link
 * strip), every link-shaped word goes, and it is cut to a name's length.
 */
export function untrustedActivityLabel(raw: string | null): string | null {
  if (raw === null) return null;
  const visible = raw
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Cc}/gu, ' ');
  const text = withoutLinks(visible).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return [...text].slice(0, MAX_ACTIVITY_LABEL_CHARS).join('').trim();
}

/** The user turn: the plan the parent is answering, then their words. No child data. */
export function signupPlanReadUserMessage(input: { text: string; offer: PlanReadOffer }): string {
  return JSON.stringify({
    offer: {
      status: input.offer.status,
      untrusted_activity_label: untrustedActivityLabel(input.offer.activity),
      host: input.offer.host,
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

// Digit runs only, thousands commas allowed, up to two decimals. Never a word list.
const AMOUNT = /\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?/g;

/** Every amount written in the parent's words, in cents (full-width digits included). */
export function amountsWritten(text: string): number[] {
  const runs = text.normalize('NFKC').match(AMOUNT) ?? [];
  return runs.map((run) => Math.round(Number(run.replace(/,/g, '')) * 100));
}

/**
 * A maximum holds on Hale's own stored facts — the highest price stated for the sessions
 * the parent chose, or a price they already accepted — or on an amount they wrote. Never
 * on the activity label or anything else a page said.
 */
function maxSupported(
  maxPriceCents: number,
  chosen: readonly SignupSession[],
  offer: PlanReadOffer,
  text: string,
): boolean {
  const stated = chosen.flatMap((session) =>
    session.priceCents === null ? [] : [session.priceCents],
  );
  if (stated.length > 0 && maxPriceCents === Math.max(...stated)) return true;
  if (offer.approvedPriceCents !== null && maxPriceCents === offer.approvedPriceCents) return true;
  return amountsWritten(text).includes(maxPriceCents);
}

/**
 * Structural checks, and the bindings above. An approval of a plan already approved
 * changes nothing. An approval naming a session outside the offer or repeating one, with
 * no usable or supported price, or with no go-ahead copied from the parent's words, is not
 * an approval of anything: it becomes `unclear` when the model gave a question, and
 * unreadable otherwise. A waiver the parent's words do not grant is not ticked.
 */
export function toPlanReading(
  raw: z.infer<typeof signupPlanReadSchema>,
  offer: PlanReadOffer,
  text: string,
): PlanReading | null {
  const named = quotesParent(text, raw.named);
  if (raw.verdict === 'take_back') return { verdict: 'take_back', named };
  if (raw.verdict === 'unrelated') return { verdict: 'unrelated' };
  if (raw.verdict === 'unclear') {
    const question = cleanQuestion(raw.question);
    return question ? { verdict: 'unclear', question } : null;
  }
  if (offer.status === 'planned') return { verdict: 'unrelated' };
  const ids = raw.choiceIds;
  const chosen = ids.flatMap((id) => offer.sessions.filter((session) => session.id === id));
  const max = raw.maxPriceCents;
  const valid =
    ids.length > 0 &&
    ids.length <= MAX_PLAN_CHOICES &&
    new Set(ids).size === ids.length &&
    chosen.length === ids.length &&
    max !== null &&
    max > 0 &&
    maxSupported(max, chosen, offer, text) &&
    quotesParent(text, raw.said);
  if (valid && max !== null) {
    return {
      verdict: 'approve',
      choiceIds: [...ids],
      maxPriceCents: max,
      waiverAccepted: raw.waiverAccepted && quotesParent(text, raw.waiverSaid),
      named,
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
        return toPlanReading(value, input.offer, input.text) ?? unreadable('unreadable');
      } catch (err) {
        return unreadable('model_failed', className(err));
      }
    },
  };
}
