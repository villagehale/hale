import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { withoutLinks } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import { namesFacts, quotesParentWords } from './parent-quote';
import { untrustedActivityLabel } from './plan/reader';

/**
 * WHETHER A NEW SIGN-UP ASK REPLACES ONE OF THIS PARENT'S EARLIER OPEN ASKS.
 *
 * A family can hold several asks at once, one per site: swim at one, gymnastics at
 * another. "不要了，要 Little Kickers" drops the gymnastics ask; "也帮我报 Little Kickers"
 * keeps it. A model reads the parent's words beside the asks; there is no word list.
 *
 * Every replaced ask must be one the model was shown, named once. A missing client or
 * skill, a model failure, or a reading that breaks that is null, and the log names which;
 * the caller stops on null. Closing an ask moves it, so an ask closes only when the words
 * the model copied as dropping it are whole words of the parent's message that name it (a
 * whole word of its program's name or its site, checked in code). Otherwise it stays open
 * beside the new one, and the reading says so (`unnamed`).
 */

export interface SupersedeAsk {
  offerId: string;
  /** Untrusted: a page or the coach model wrote it ({@link untrustedActivityLabel}). */
  activity: string | null;
  host: string;
  sessionLabels: readonly string[];
}

export interface SupersedeReadInput {
  text: string;
  next: { activity: string | null; host: string };
  earlier: readonly SupersedeAsk[];
}

export interface SupersedeReading {
  /** The offer ids of the earlier asks the parent's words drop and name: these close. */
  replaced: string[];
  /** The offer ids the model read as dropped in words that do not name them: these stay open. */
  unnamed: string[];
}

export interface SignupSupersedeReader {
  /** Which earlier asks close, and which the model dropped unnamed; null when unreadable. */
  read(input: SupersedeReadInput): Promise<SupersedeReading | null>;
}

const MAX_TEXT_CHARS = 1600;
export const SIGNUP_SUPERSEDE_READ_SKILL = 'signup-offer-supersede';
export const SIGNUP_SUPERSEDE_READ_TOOL = 'signup_offer_supersede';
export const SIGNUP_SUPERSEDE_READ_TOOL_DESCRIPTION =
  "Name the earlier sign-up asks the parent's words drop for the new one, if any.";
export const SIGNUP_SUPERSEDE_READ_MAX_TOKENS = 1024;

export const signupSupersedeReadSchema = z
  .object({
    reason: z.string(),
    replaced: z.array(z.object({ ref: z.string(), said: z.string() }).strict()),
  })
  .strict();

export const SIGNUP_SUPERSEDE_READ_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    replaced: {
      type: 'array',
      items: {
        type: 'object',
        properties: { ref: { type: 'string' }, said: { type: 'string' } },
        required: ['ref', 'said'],
        additionalProperties: false,
      },
    },
  },
  required: ['reason', 'replaced'],
  additionalProperties: false,
} as const;

/** Positional, so a recorded read never keys on an offer's uuid. */
function refFor(index: number): string {
  return `ask-${index + 1}`;
}

/** The user turn: the new ask, the parent's earlier open asks, then their words. No child. */
export function signupSupersedeReadUserMessage(input: SupersedeReadInput): string {
  return JSON.stringify({
    newAsk: {
      untrusted_activity_label: untrustedActivityLabel(input.next.activity),
      host: input.next.host,
    },
    earlierAsks: input.earlier.map((ask, index) => ({
      ref: refFor(index),
      untrusted_activity_label: untrustedActivityLabel(ask.activity),
      host: ask.host,
      sessions: ask.sessionLabels.map((label) => withoutLinks(label)),
    })),
    text: input.text.slice(0, MAX_TEXT_CHARS),
  });
}

/**
 * Each replaced ref must be a shown ask, once. It closes only when `said` is whole words of
 * the parent's that name it; otherwise it is `unnamed`, and stays open.
 */
export function toSupersedeReading(
  raw: z.infer<typeof signupSupersedeReadSchema>,
  earlier: readonly SupersedeAsk[],
  text: string,
): SupersedeReading | null {
  const reading: SupersedeReading = { replaced: [], unnamed: [] };
  for (const item of raw.replaced) {
    const ask = earlier.find((_, index) => refFor(index) === item.ref);
    if (!ask || [...reading.replaced, ...reading.unnamed].includes(ask.offerId)) return null;
    const named =
      quotesParentWords(text, item.said) &&
      namesFacts(item.said, { activity: untrustedActivityLabel(ask.activity), host: ask.host });
    (named ? reading.replaced : reading.unnamed).push(ask.offerId);
  }
  return reading;
}

function className(err: unknown): string {
  return err instanceof Error ? err.constructor.name : 'unknown';
}

function unreadable(reason: string, detail?: string): null {
  console.info({ reason, detail }, 'signup supersede read: unreadable');
  return null;
}

/** `client` is a resolver: a missing key is unreadable, never a throw. */
export function createSignupSupersedeReader(
  client: () => AgentClient | null | Promise<AgentClient | null>,
): SignupSupersedeReader {
  return {
    async read(input) {
      if (!input.text.trim()) return unreadable('no_text');
      let resolved: AgentClient | null;
      try {
        resolved = await client();
      } catch (err) {
        return unreadable('client_unavailable', className(err));
      }
      if (!resolved) return unreadable('client_unavailable');
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill(SIGNUP_SUPERSEDE_READ_SKILL);
      } catch (err) {
        return unreadable('skill_unavailable', className(err));
      }
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: signupSupersedeReadUserMessage(input),
          toolName: SIGNUP_SUPERSEDE_READ_TOOL,
          toolDescription: SIGNUP_SUPERSEDE_READ_TOOL_DESCRIPTION,
          inputJsonSchema: SIGNUP_SUPERSEDE_READ_TOOL_SCHEMA,
          schema: signupSupersedeReadSchema,
          maxTokens: SIGNUP_SUPERSEDE_READ_MAX_TOKENS,
        });
        return toSupersedeReading(value, input.earlier, input.text) ?? unreadable('unreadable');
      } catch (err) {
        return unreadable('model_failed', className(err));
      }
    },
  };
}
