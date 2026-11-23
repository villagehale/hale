import { type AgentClient, hasGarbledText, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape, withoutLinks, noteLinkGate } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { PlanCharged } from '~/lib/signup/browser-use/plan-engine';
import { SITE_CHOICE_LABEL_MAX_CHARS } from '~/lib/signup/site-choices';
import { moneyCentsWritten } from '~/lib/signup/terms/money';
import {
  MAX_PAGE_QUOTE_CHARS,
  MAX_PREREQUISITE_QUOTE_CHARS,
  untrustedPageWords,
} from '~/lib/signup/terms/page-words';
import type { CartDifference, SignupTermsHold, SignupTermsShown } from '~/lib/signup/terms/types';

/**
 * VIL-558 · EVERY TEXT ABOUT A REGISTRATION PLAN.
 *
 * The offer, the confirmation, a take-back, a question and the notice after the run are
 * all model-written from these facts. There is no fixed line here. The model never writes
 * a link: when the parent needs one, code appends it after the text, so a live-view link
 * never reaches a model and a draft cannot point anywhere else.
 *
 * A missing client, skill or a failed draft returns null and names why. Nothing falls
 * back to stock copy.
 */

export type PlanReplyMoment =
  | 'offer'
  | 'approved'
  | 'cancelled'
  | 'declined'
  | 'clarify'
  | 'refused'
  | 'run_finished';

export interface PlanReplySession {
  label: string;
  startsAt: string;
  endsAt: string;
  priceCents: number | null;
}

export interface PlanRunFacts {
  outcome: string;
  detail: string;
  confirmed: boolean;
  sessionLabel: string | null;
  cartTotalCents: number | null;
  amountChargedCents: number | null;
  /** What Hale's run charged, from the engine: `nothing`, `unknown`, or the cents read. */
  charged: PlanCharged;
  liveBrowser: boolean;
  holdMinutes: number | null;
  /** VIL-715 · what differed from the approval, on a `cart_mismatch`. Absent otherwise. */
  cartDifferences?: CartDifference[];
}

/**
 * VIL-715 · what Hale read on the program's page, for the text that asks and the texts after
 * it. Absent on an ask without terms, so the writer's request stays what it was.
 */
export interface PlanReplyTerms {
  free: boolean;
  /** The prices this family may be charged. */
  rates: SignupTermsShown['sessions'][number]['rates'];
  residency: SignupTermsShown['residency'];
  tax: SignupTermsShown['sessions'][number]['tax'];
  refund: string | null;
  ageFit: SignupTermsShown['age']['fit'];
  ageBand: string | null;
  prerequisite: SignupTermsShown['prerequisite'];
  priorChargeUnknown: boolean;
  /** What Hale could not confirm on the page, by name. */
  unread: ('page' | 'refund' | 'age' | 'prerequisite' | 'price')[];
  /** The approval's ack: Hale starts now and will text when it is done. */
  runsNow?: boolean;
  /** The approval's ack: Hale will stop at checkout for the parent to finish. */
  hold?: SignupTermsHold | null;
}

export interface PlanReplyFacts {
  moment: PlanReplyMoment;
  /**
   * `auto`: Hale registers and pays with the card saved on the city account. `assisted`
   * (ActiveNet): Hale fills the registration and the parent submits and pays on the live browser.
   */
  mode: 'auto' | 'assisted';
  childFirstName: string | null;
  opensAt: { local: string; timeZone: string };
  sessions: readonly PlanReplySession[];
  maxPriceCents: number | null;
  waiverAccepted: boolean | null;
  question: string | null;
  refusal: string | null;
  run: PlanRunFacts | null;
  language: string | null;
  terms?: PlanReplyTerms;
  /** VIL-715 · the labels of the site's options, for a question about them. A page wrote them. */
  siteOptions?: readonly string[];
  /** VIL-715 · this offer has a terms row, so a page wrote its session labels. */
  labelsFromPage?: boolean;
}

export interface PlanReplyWriter {
  write(facts: PlanReplyFacts): Promise<string | null>;
}

export const SIGNUP_PLAN_REPLY_SKILL = 'signup-plan-reply';
/** VIL-715 · the addendum for a text that states terms. Loaded only when they are present. */
export const SIGNUP_PLAN_TERMS_SKILL = 'signup-plan-terms';
export const SIGNUP_PLAN_REPLY_TOOL = 'signup_plan_reply';
export const SIGNUP_PLAN_REPLY_TOOL_DESCRIPTION =
  'Write the one text the parent sees about this registration plan.';
export const SIGNUP_PLAN_REPLY_MAX_TOKENS = 800;
export const signupPlanReplySchema = z.object({ text: z.string() }).strict();
export const SIGNUP_PLAN_REPLY_TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
  additionalProperties: false,
} as const;

/** Moments where the parent is told about queueing on their own phone as well. */
const QUEUE_MOMENTS: ReadonlySet<PlanReplyMoment> = new Set(['offer', 'approved']);

const MONEY =
  /(?:\$\s*(\d+)(?:\.(\d{2}))?|(\d+)(?:\.(\d{2}))?\s*\$|(\d+)\s*(?:dollars|cad|usd|加元))/gi;
const CLOCK =
  /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b|\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b|\b(\d{1,2})(a\.?m\.?|p\.?m\.?)\b|\b(\d{1,2})h(\d{2})\b/gi;

export function moneyCentsIn(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(MONEY)) {
    const dollars = Number(match[1] ?? match[3] ?? match[5]);
    const fraction = match[2] ?? match[4];
    if (!Number.isFinite(dollars)) continue;
    out.push(dollars * 100 + (fraction ? Number(fraction) : 0));
  }
  return out;
}

function knownCents(facts: PlanReplyFacts): Set<number> {
  const known = new Set<number>();
  const add = (value: number | null | undefined) => {
    if (value == null || !Number.isFinite(value)) return;
    known.add(value);
  };
  add(facts.maxPriceCents);
  for (const session of facts.sessions) add(session.priceCents);
  add(facts.run?.cartTotalCents);
  add(facts.run?.amountChargedCents);
  if (typeof facts.run?.charged === 'object') add(facts.run.charged.cents);
  for (const rate of facts.terms?.rates ?? []) add(rate.cents);
  return known;
}

function clockMinutes(hour: number, minute: number, mer: string | undefined): number | null {
  if (hour > 23 || minute > 59) return null;
  const ap = mer?.replace(/\./g, '').toLowerCase();
  let h = hour;
  if (ap === 'am' || ap === 'pm') {
    if (hour > 12) return null;
    if (ap === 'am') h = hour === 12 ? 0 : hour;
    else h = hour === 12 ? 12 : hour + 12;
  }
  return h * 60 + minute;
}

export function clocksIn(text: string): number[] {
  const out: number[] = [];
  for (const match of text.matchAll(CLOCK)) {
    if (match[1] !== undefined) {
      const mins = clockMinutes(Number(match[1]), Number(match[2]), match[3]);
      if (mins !== null) out.push(mins);
      continue;
    }
    if (match[4] !== undefined) {
      const mins = clockMinutes(Number(match[4]), 0, match[5]);
      if (mins !== null) out.push(mins);
      continue;
    }
    if (match[6] !== undefined) {
      const mins = clockMinutes(Number(match[6]), 0, match[7]);
      if (mins !== null) out.push(mins);
      continue;
    }
    if (match[8] !== undefined) {
      const mins = clockMinutes(Number(match[8]), Number(match[9]), undefined);
      if (mins !== null) out.push(mins);
    }
  }
  return out;
}

function knownClocks(facts: PlanReplyFacts): Set<number> {
  const blobs = [
    facts.opensAt.local,
    ...facts.sessions.map((session) => session.label),
    ...(facts.terms?.refund ? [facts.terms.refund] : []),
  ];
  const known = new Set<number>();
  for (const blob of blobs) {
    for (const value of clocksIn(blob)) known.add(value);
  }
  return known;
}

/** Why a draft cannot leave. Empty means it can. */
export function planReplyViolations(text: string, facts?: PlanReplyFacts): string[] {
  const out: string[] = [];
  const tidy = text.trim();
  if (!tidy) out.push('empty');
  if (hasLinkShape(tidy)) {
    noteLinkGate('signup-plan', 'redraft');
    out.push('contains a link: Hale adds any link after the text');
  }
  if (hasGarbledText(tidy)) {
    out.push('garbled characters: an accented letter came out as two or three other characters');
  }
  if (facts) {
    const allowedMoney = knownCents(facts);
    // A text that states terms reads its figures with the parser that knows every form a
    // price takes. Without terms, the gate reads the text as it always has.
    const written = facts.terms ? moneyCentsWritten(tidy) : moneyCentsIn(tidy);
    if (
      allowedMoney.size === 0
        ? written.length > 0
        : written.some((cents) => !allowedMoney.has(cents))
    ) {
      out.push('invented figure: a price or limit that is not in the facts');
    }
    if (
      facts.terms &&
      !facts.terms.free &&
      facts.moment === 'offer' &&
      facts.terms.rates.some((rate) => rate.cents > 0 && !written.includes(rate.cents))
    ) {
      out.push('missing price: every price in terms.rates has to be in the text');
    }
    const allowedClocks = knownClocks(facts);
    if (clocksIn(tidy).some((mins) => !allowedClocks.has(mins))) {
      out.push('invented figure: a time that is not in the facts');
    }
  }
  return out;
}

const CJK = String.raw`\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}`;
const CJK_BEFORE_LATIN = new RegExp(`([${CJK}\u3002])(?=[A-Za-z])`, 'gu');
const LATIN_BEFORE_CJK = new RegExp(`([A-Za-z])(?=[${CJK}])`, 'gu');

/**
 * The draft as it is sent: whitespace collapsed, and a space wherever a Latin word touches
 * Chinese or Japanese. A phone reads "名额。Hale" or "Ada报上名。链接" as a host, so the link
 * gate rightly refuses them, and these drafts name the child and Hale in Latin letters. A
 * space only makes text less link-like, and the gate reads exactly what is sent.
 */
export function planReplyText(raw: string): string {
  return raw
    .replace(CJK_BEFORE_LATIN, '$1 ')
    .replace(LATIN_BEFORE_CJK, '$1 ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Labels and the question come from a page or a model: no link in them reaches the writer. */
function linkFree(facts: PlanReplyFacts): PlanReplyFacts {
  return {
    ...facts,
    sessions: facts.sessions.map((session) => ({ ...session, label: withoutLinks(session.label) })),
    question: facts.question === null ? null : withoutLinks(facts.question),
    run:
      facts.run === null
        ? null
        : {
            ...facts.run,
            sessionLabel:
              facts.run.sessionLabel === null ? null : withoutLinks(facts.run.sessionLabel),
          },
  };
}

/** What a page wrote, as the writer sees it: cleaned, and marked as never an instruction. */
function markedTerms({
  refund,
  ageBand,
  prerequisite: { quote, ...prerequisite },
  ...terms
}: PlanReplyTerms) {
  return {
    ...terms,
    untrusted_refund_quote: untrustedPageWords(refund, MAX_PAGE_QUOTE_CHARS),
    untrusted_age_band: untrustedPageWords(ageBand, MAX_PAGE_QUOTE_CHARS),
    prerequisite: {
      ...prerequisite,
      untrusted_quote: untrustedPageWords(quote, MAX_PREREQUISITE_QUOTE_CHARS),
    },
  };
}

/** A session's label on these texts can be a site option's: a page wrote it. */
function markedLabels<T extends Pick<PlanReplyFacts, 'sessions' | 'run'>>(facts: T) {
  const label = (raw: string | null) => untrustedPageWords(raw, SITE_CHOICE_LABEL_MAX_CHARS);
  let run = null;
  if (facts.run !== null) {
    const { sessionLabel, ...rest } = facts.run;
    run = { ...rest, untrusted_session_label: label(sessionLabel) };
  }
  return {
    ...facts,
    sessions: facts.sessions.map(({ label: raw, ...session }) => ({
      ...session,
      untrusted_label: label(raw),
    })),
    run,
  };
}

function markedSiteOptions(labels: readonly string[]): string[] {
  return labels.flatMap((label) => untrustedPageWords(label, SITE_CHOICE_LABEL_MAX_CHARS) ?? []);
}

/** The user turn: the facts, and why the last draft could not leave. */
export function planReplyUserMessage(facts: PlanReplyFacts, violation: string | null): string {
  const { terms, siteOptions, labelsFromPage: _labelsFromPage, ...rest } = linkFree(facts);
  const clean = {
    ...(planReplyUsesTermsSkill(facts) ? markedLabels(rest) : rest),
    ...(terms ? { terms: markedTerms(terms) } : {}),
    ...(siteOptions ? { untrusted_site_options: markedSiteOptions(siteOptions) } : {}),
  };
  return JSON.stringify({
    facts: QUEUE_MOMENTS.has(clean.moment) ? { ...clean, alsoQueueing: true } : clean,
    violation,
  });
}

/** Terms, page options or page-written labels bring the addendum that says how to treat them. */
export function planReplyUsesTermsSkill(facts: PlanReplyFacts): boolean {
  return (
    facts.terms !== undefined || facts.siteOptions !== undefined || facts.labelsFromPage === true
  );
}

/** Wall time in the parent's zone, for the writer to restate. */
export function planOpensAtLocal(opensAt: Date, timeZone: string): PlanReplyFacts['opensAt'] {
  const local = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(opensAt);
  return { local, timeZone };
}

/** The text as sent: the model's words, then the one link code chose, on its own line. */
export function planReplyBody(text: string, link: string | null): string {
  return link ? `${text}\n${link}` : text;
}

function unwritten(reason: string, detail?: string): null {
  console.info({ reason, detail }, 'signup plan reply: not sent');
  return null;
}

function className(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

/** `client` is a resolver: a missing key is unwritten, never a throw. */
export function createPlanReplyWriter(
  client: () => AgentClient | null | Promise<AgentClient | null>,
): PlanReplyWriter {
  return {
    async write(facts) {
      let resolved: AgentClient | null;
      try {
        resolved = await client();
      } catch (err) {
        return unwritten('client_unavailable', className(err));
      }
      if (!resolved) return unwritten('client_unavailable');
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      let system: string;
      try {
        skill = await loadCronSkill(SIGNUP_PLAN_REPLY_SKILL);
        system = planReplyUsesTermsSkill(facts)
          ? `${skill.instructions}\n\n${(await loadCronSkill(SIGNUP_PLAN_TERMS_SKILL)).instructions}`
          : skill.instructions;
      } catch (err) {
        return unwritten('skill_unavailable', className(err));
      }
      let note: string | null = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system,
            userMessage: planReplyUserMessage(facts, note),
            toolName: SIGNUP_PLAN_REPLY_TOOL,
            toolDescription: SIGNUP_PLAN_REPLY_TOOL_DESCRIPTION,
            inputJsonSchema: SIGNUP_PLAN_REPLY_TOOL_SCHEMA,
            schema: signupPlanReplySchema,
            maxTokens: SIGNUP_PLAN_REPLY_MAX_TOKENS,
          });
          const text = planReplyText(value.text);
          const violations = planReplyViolations(text, facts);
          if (violations.length === 0) return text;
          note = violations.join('; ');
        } catch (err) {
          return unwritten('model_failed', className(err));
        }
      }
      return unwritten('violations', note ?? '');
    },
  };
}
