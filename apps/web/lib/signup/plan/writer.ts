import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape, withoutLinks } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';

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

/** Why a draft cannot leave. Empty means it can. */
export function planReplyViolations(text: string): string[] {
  const out: string[] = [];
  const tidy = text.trim();
  if (!tidy) out.push('empty');
  if (hasLinkShape(tidy)) out.push('contains a link: Hale adds any link after the text');
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
          const violations = planReplyViolations(text);
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
