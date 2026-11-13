import { type AgentClient, hasGarbledText, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape, withoutLinks } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { PlanCharged } from '~/lib/signup/browser-use/plan-engine';

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
}

export interface PlanReplyWriter {
  write(facts: PlanReplyFacts): Promise<string | null>;
}

export const SIGNUP_PLAN_REPLY_SKILL = 'signup-plan-reply';
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
  const blobs = [facts.opensAt.local, ...facts.sessions.map((session) => session.label)];
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
  if (hasLinkShape(tidy)) out.push('contains a link: Hale adds any link after the text');
  if (hasGarbledText(tidy)) {
    out.push('garbled characters: an accented letter came out as two or three other characters');
  }
  if (facts) {
    const allowedMoney = knownCents(facts);
    if (
      allowedMoney.size === 0
        ? moneyCentsIn(tidy).length > 0
        : moneyCentsIn(tidy).some((cents) => !allowedMoney.has(cents))
    ) {
      out.push('invented figure: a price or limit that is not in the facts');
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

/** The user turn: the facts, and why the last draft could not leave. */
export function planReplyUserMessage(facts: PlanReplyFacts, violation: string | null): string {
  const clean = linkFree(facts);
  return JSON.stringify({
    facts: QUEUE_MOMENTS.has(clean.moment) ? { ...clean, alsoQueueing: true } : clean,
    violation,
  });
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
      try {
        skill = await loadCronSkill(SIGNUP_PLAN_REPLY_SKILL);
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
