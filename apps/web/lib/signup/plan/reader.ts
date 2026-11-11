import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape, withoutLinks } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import { foldWords, namesFacts, quotesParent, sharesWord } from '../parent-quote';
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
 * maximum only on a price Hale's offer stated or an amount of money they wrote; the waiver
 * only on a plan whose waiver question Hale sent, and only on their own words that are no
 * part of the go-ahead (`waiverSaid`). A plan is named only by their own words: words with
 * a whole word of its program's name or its site, or words the model read as naming it
 * that share no word with the untrusted label. Anything else fails closed.
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
  /**
   * Hale sent the parent a text asking whether it may tick this plan's waiver (a recorded
   * `ask_waiver` notice). Until one did, no answer of theirs ticks it, and a waiver on the
   * site hands the registration back to them at checkout. Code only: never shown to the
   * model.
   */
  asksWaiver: boolean;
}

/**
 * How the parent's own words (`named`, copied from their message) name this plan: by a
 * whole word of its program's name or its site (`tokens`), or by the model's reading of
 * words in another language than the label that share no word with it (`reader`). A plan
 * other than the parent's newest is only ever moved on words that name it.
 */
export type PlanNaming = 'tokens' | 'reader';

export type PlanReading =
  | {
      verdict: 'approve';
      choiceIds: string[];
      maxPriceCents: number;
      waiverAccepted: boolean;
      named: PlanNaming | null;
    }
  | { verdict: 'take_back'; named: PlanNaming | null }
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
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?`;
const BARE = new RegExp(AMOUNT, 'g');
// An amount of money: a currency sign or word on either side of it. A sign right before
// another number is that number's, so "the 2027 $98 session" is $98 and never $2027.
const SIGN_FIRST = new RegExp(String.raw`(?:[$€£¥]|\b(?:cad|usd)\b)\s*(${AMOUNT})(?!\d)`, 'giu');
const SIGN_AFTER = new RegExp(
  String.raw`(?<![\d.,])(${AMOUNT})\s*(?:[$€£¥](?!\s*\d)|加元|美元|元|块|(?:dollars?|bucks|cad|usd)\b)`,
  'giu',
);

function cents(run: string): number {
  return Math.round(Number(run.replace(/,/g, '')) * 100);
}

/** Every amount of money in the parent's words, in cents (full-width digits included). */
export function moneyWritten(text: string): number[] {
  const normal = text.normalize('NFKC');
  return [...normal.matchAll(SIGN_FIRST), ...normal.matchAll(SIGN_AFTER)].flatMap((match) =>
    match[1] === undefined ? [] : [cents(match[1])],
  );
}

/**
 * A maximum holds on Hale's own stored facts — the highest price stated for the sessions
 * the parent chose, or a price they already accepted — on an amount of money they wrote,
 * or on a bare number they wrote that is a price Hale's offer stated. Never on the activity
 * label, and never on any other number (an address, a year).
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
  if (moneyWritten(text).includes(maxPriceCents)) return true;
  const offered = [
    offer.approvedPriceCents,
    ...offer.sessions.map((session) => session.priceCents),
  ];
  const bare = (text.normalize('NFKC').match(BARE) ?? []).map(cents);
  return offered.includes(maxPriceCents) && bare.includes(maxPriceCents);
}

/**
 * The waiver answer holds only on a plan whose waiver question Hale sent, and only on the
 * parent's own words that are no part of the go-ahead: the go-ahead, or any span of it, is
 * still the go-ahead.
 */
function waiverGranted(
  raw: z.infer<typeof signupPlanReadSchema>,
  offer: PlanReadOffer,
  text: string,
): boolean {
  const { waiverSaid, said } = raw;
  return (
    offer.asksWaiver &&
    raw.waiverAccepted &&
    waiverSaid !== null &&
    quotesParent(text, waiverSaid) &&
    (said === null || !foldWords(said).includes(foldWords(waiverSaid)))
  );
}

/**
 * The parent's own words name this plan by a whole word of its program's name or its site.
 * Or the model read them as naming it, in words that share no word with the untrusted label
 * (游泳那个 for "Preschool Swim"), so they cannot be an echo of the label's text; the model
 * judged this plan with the label marked untrusted. With no label kept, it had none to
 * judge by. Words sharing only short words with the label name nothing.
 */
function planNaming(
  raw: z.infer<typeof signupPlanReadSchema>,
  offer: PlanReadOffer,
  text: string,
): PlanNaming | null {
  if (raw.named === null || !quotesParent(text, raw.named)) return null;
  const label = untrustedActivityLabel(offer.activity);
  if (namesFacts(raw.named, { activity: label, host: offer.host })) return 'tokens';
  if (label !== null && !sharesWord(raw.named, label)) return 'reader';
  return null;
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
  const named = planNaming(raw, offer, text);
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
      waiverAccepted: waiverGranted(raw, offer, text),
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
