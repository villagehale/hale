import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape, withoutLinks } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import type { SiteChoice } from '../site-choices';

export const SIGNUP_MISMATCH_READ_SKILL = 'signup-mismatch-read';
export const SIGNUP_MISMATCH_READ_TOOL = 'signup_mismatch_read';
export const SIGNUP_MISMATCH_READ_MAX_TOKENS = 1024;
export const SIGNUP_MISMATCH_READ_TOOL_DESCRIPTION =
  'Decide which site option the parent picked, if any.';

const VERDICTS = ['waitlist', 'option', 'email', 'retry', 'unclear', 'unrelated'] as const;

export type MismatchReading =
  /** `choiceId`: the site's waitlist choice they named, or null. */
  | { verdict: 'waitlist'; choiceId: string | null }
  | { verdict: 'option'; choiceId: string }
  | { verdict: 'email' }
  /** The provider fixed it: try what they asked for again. */
  | { verdict: 'retry' }
  | { verdict: 'unclear'; question: string }
  | { verdict: 'unrelated' };

export interface MismatchReadInput {
  text: string;
  askedStart: string | null;
  choices: readonly SiteChoice[];
  /** True once Hale drafted the provider email: their words may relay its answer. */
  emailed?: true;
}

export interface MismatchReader {
  read(input: MismatchReadInput): Promise<MismatchReading | null>;
}

export const signupMismatchReadSchema = z
  .object({
    reason: z.string(),
    verdict: z.enum(VERDICTS),
    choiceId: z.string().nullable(),
    question: z.string().nullable(),
  })
  .strict();

export const SIGNUP_MISMATCH_READ_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    reason: { type: 'string' },
    verdict: { type: 'string', enum: [...VERDICTS] },
    choiceId: { type: ['string', 'null'] },
    question: { type: ['string', 'null'] },
  },
  required: ['reason', 'verdict', 'choiceId', 'question'],
  additionalProperties: false,
} as const;

export function toMismatchReading(
  raw: z.infer<typeof signupMismatchReadSchema>,
  choices: readonly SiteChoice[],
): MismatchReading | null {
  if (raw.verdict === 'waitlist') {
    const id = raw.choiceId?.trim() ?? '';
    const waitlists = choices.filter((choice) => choice.waitlist);
    // A named waitlist choice, or the page's only one.
    const named =
      waitlists.find((choice) => choice.id === id) ??
      (waitlists.length === 1 ? waitlists[0] : undefined);
    return { verdict: 'waitlist', choiceId: named ? named.id : null };
  }
  if (raw.verdict === 'email') return { verdict: 'email' };
  if (raw.verdict === 'retry') return { verdict: 'retry' };
  if (raw.verdict === 'unrelated') return { verdict: 'unrelated' };
  if (raw.verdict === 'option') {
    const id = raw.choiceId?.trim() ?? '';
    return id && choices.some((choice) => choice.id === id)
      ? { verdict: 'option', choiceId: id }
      : null;
  }
  const question = raw.question?.replace(/\s+/g, ' ').trim() ?? '';
  if (!question || question.length > 320 || hasLinkShape(question)) return null;
  return { verdict: 'unclear', question };
}

export function signupMismatchReadUserMessage(input: MismatchReadInput): string {
  return JSON.stringify({
    ...(input.emailed ? { emailed: true } : {}),
    askedStart: input.askedStart,
    choices: input.choices.map((choice) => ({
      ...choice,
      label: withoutLinks(choice.label),
      billing_note: choice.billing_note ? withoutLinks(choice.billing_note) : null,
    })),
    text: input.text.slice(0, 1600),
  });
}

export function createMismatchReader(
  client: () => AgentClient | null | Promise<AgentClient | null>,
): MismatchReader {
  return {
    async read(input) {
      if (!input.text.trim()) return null;
      let resolved: AgentClient | null;
      try {
        resolved = await client();
      } catch {
        return null;
      }
      if (!resolved) return null;
      let skill: Awaited<ReturnType<typeof loadCronSkill>>;
      try {
        skill = await loadCronSkill(SIGNUP_MISMATCH_READ_SKILL);
      } catch {
        return null;
      }
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: signupMismatchReadUserMessage(input),
          toolName: SIGNUP_MISMATCH_READ_TOOL,
          toolDescription: SIGNUP_MISMATCH_READ_TOOL_DESCRIPTION,
          inputJsonSchema: SIGNUP_MISMATCH_READ_TOOL_SCHEMA,
          schema: signupMismatchReadSchema,
          maxTokens: SIGNUP_MISMATCH_READ_MAX_TOKENS,
        });
        return toMismatchReading(value, input.choices);
      } catch {
        return null;
      }
    },
  };
}
