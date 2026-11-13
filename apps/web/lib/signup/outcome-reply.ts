import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasGarbledText } from '~/lib/format/garbled-text';
import { foreignLinks } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';

/**
 * THE TEXT A PARENT SEES ABOUT A SIGN-UP (T8 / VIL-453).
 *
 * The reply model writes it from the structured outcome. There are no fixed
 * lines here. `confirmed` is computed by the caller from captured evidence;
 * the model is told it may claim success only when it is true, and a draft
 * that leaves out the hand-off link or adds another one does not send.
 *
 * A missing client, skill or a failed draft returns null and nothing is sent.
 */

export interface SignupOutcomeFacts {
  outcome: string;
  reason: string | null;
  /** True only when a confirmation was captured. See `run.ts` `confirmedOutcome`. */
  confirmed: boolean;
  sessionLabel: string | null;
  link: string;
  /**
   * What `link` opens: the provider's own registration page, or a browser Hale left
   * open on the provider's site holding the page or cart. Null when `link` is ''.
   */
  linkIs: 'registration_page' | 'live_browser' | null;
  /** Minutes the provider said it holds the cart, for `live_browser` only. 0 = it may have run out. */
  holdMinutes: number | null;
  /** Who reads the text: the one parent in a 1:1 thread, or the co-parent group. */
  audience: 'direct' | 'group';
  prefilled: readonly string[];
  /**
   * A hand-back where the parent fills the registration form: the parent's prepared
   * details to have ready (slot and value). Only after a yes in a 1:1 thread.
   */
  pack?: readonly { slot: string; value: string }[];
  rush: { signal: string; opensAt: string | null; prefillSlots: readonly string[] } | null;
  /** Clarifying question from the consent read, when the parent was unclear. */
  question: string | null;
  language: string | null;
}

export interface SignupOutcomeWriter {
  write(facts: SignupOutcomeFacts): Promise<string | null>;
}

export const SIGNUP_OUTCOME_TOOL = 'signup_outcome_reply';
export const SIGNUP_OUTCOME_TOOL_DESCRIPTION =
  'Write the one text the parent sees about this sign-up.';
export const SIGNUP_OUTCOME_MAX_TOKENS = 300;
export const signupOutcomeSchema = z.object({ text: z.string() });
export const SIGNUP_OUTCOME_TOOL_SCHEMA = {
  type: 'object',
  properties: { text: { type: 'string' } },
  required: ['text'],
} as const;

/**
 * Why a draft cannot leave, each as 'code' or 'code: the words', so the retry knows exactly
 * what to change. Empty means it can. The pack is read from the family record: the
 * parent's own email is trusted in its slot only, and a name only when it is not link-shaped.
 */
export function signupOutcomeViolations(text: string, facts: SignupOutcomeFacts): string[] {
  const out: string[] = [];
  const tidy = text.trim();
  if (!tidy) out.push('empty');
  const links = foreignLinks(tidy, {
    handed: facts.link ? [facts.link] : [],
    email: facts.pack?.find((item) => item.slot === 'parent_email')?.value ?? null,
    words: (facts.pack ?? [])
      .filter((item) => item.slot !== 'parent_email')
      .map((item) => item.value),
  });
  if (facts.link && !tidy.includes(facts.link)) out.push('missing the hand-off link');
  if (links.length > 0) {
    out.push(`${facts.link ? 'contains another link' : 'contains a link'}: ${links.join(', ')}`);
  }
  if (hasGarbledText(tidy)) {
    out.push('garbled characters: an accented letter came out as two or three other characters');
  }
  return out;
}

/** A log carries the codes, never the draft's words. */
function violationCodes(violations: readonly string[]): string {
  return violations.map((violation) => violation.split(':')[0]).join('; ');
}

/** The user turn the writer sends: the facts, and why the last draft could not leave. */
export function signupOutcomeUserMessage(
  facts: SignupOutcomeFacts,
  violation: string | null,
): string {
  return JSON.stringify({ facts, violation });
}

function unwritten(reason: string, detail?: string): null {
  console.info({ reason, detail }, 'signup outcome reply: not sent');
  return null;
}

export function createSignupOutcomeWriter(
  client: () => AgentClient | null | Promise<AgentClient | null>,
): SignupOutcomeWriter {
  return {
    async write(facts) {
      let resolved: AgentClient | null;
      try {
        resolved = await client();
      } catch (err) {
        return unwritten('client_unavailable', err instanceof Error ? err.constructor.name : '');
      }
      if (!resolved) return unwritten('client_unavailable');
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill('signup-outcome-reply');
      } catch {
        return unwritten('skill_unavailable');
      }
      let note: string | null = null;
      let codes = '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const { value } = await forceToolJson({
            client: resolved,
            lane: pickLane(skill.meta.task),
            system: skill.instructions,
            userMessage: signupOutcomeUserMessage(facts, note),
            toolName: SIGNUP_OUTCOME_TOOL,
            toolDescription: SIGNUP_OUTCOME_TOOL_DESCRIPTION,
            inputJsonSchema: SIGNUP_OUTCOME_TOOL_SCHEMA,
            schema: signupOutcomeSchema,
            maxTokens: SIGNUP_OUTCOME_MAX_TOKENS,
          });
          const violations = signupOutcomeViolations(value.text, facts);
          if (violations.length === 0) return value.text.replace(/\s+/g, ' ').trim();
          note = violations.join('; ');
          codes = violationCodes(violations);
        } catch {
          return unwritten('model_failed');
        }
      }
      return unwritten('violations', codes);
    },
  };
}
