import { type AgentClient, pickLane } from '@hale/agent';
import { z } from 'zod';
import { loadCronSkill } from '~/lib/cron/skill';
import { hasLinkShape, withoutLinks, noteLinkGate } from '~/lib/format/link-shape';
import { forceToolJson } from '~/lib/pipeline/structured';
import { SITE_CHOICE_LABEL_MAX_CHARS, type SiteChoice } from '../site-choices';
import { SIGNUP_PAGE_WORDS_SKILL, markedSiteChoice, untrustedPageWords } from '../terms/page-words';

export const SIGNUP_MISMATCH_READ_SKILL = 'signup-mismatch-read';
export const SIGNUP_MISMATCH_READ_TOOL = 'signup_mismatch_read';
export const SIGNUP_MISMATCH_READ_MAX_TOKENS = 1024;

const VERDICTS = ['waitlist', 'option', 'email', 'unclear', 'unrelated'] as const;

export type MismatchReading =
  | { verdict: 'waitlist' }
  | { verdict: 'option'; choiceId: string }
  | { verdict: 'email' }
  | { verdict: 'unclear'; question: string }
  | { verdict: 'unrelated' };

export interface MismatchReader {
  read(input: {
    text: string;
    askedStart: string | null;
    choices: readonly SiteChoice[];
    /** The offer has a terms row: the options reach the reader marked. */
    labelsFromPage?: boolean;
  }): Promise<MismatchReading | null>;
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
  if (raw.verdict === 'waitlist') return { verdict: 'waitlist' };
  if (raw.verdict === 'email') return { verdict: 'email' };
  if (raw.verdict === 'unrelated') return { verdict: 'unrelated' };
  if (raw.verdict === 'option') {
    const id = raw.choiceId?.trim() ?? '';
    return id && choices.some((choice) => choice.id === id)
      ? { verdict: 'option', choiceId: id }
      : null;
  }
  const question = raw.question?.replace(/\s+/g, ' ').trim() ?? '';
  if (question && hasLinkShape(question)) noteLinkGate('signup-mismatch', 'refused');
  if (!question || question.length > 320 || hasLinkShape(question)) return null;
  return { verdict: 'unclear', question };
}

/** A page can write an option's own id, so on a marked ask the reader picks by position. */
function positionId(index: number): string {
  return `option_${index + 1}`;
}

/** The model's pick, as an id Hale holds. On a marked ask the model picked by position. */
export function mismatchReadingFrom(
  raw: z.infer<typeof signupMismatchReadSchema>,
  input: { choices: readonly SiteChoice[]; labelsFromPage?: boolean },
): MismatchReading | null {
  if (!input.labelsFromPage) return toMismatchReading(raw, input.choices);
  const reading = toMismatchReading(
    raw,
    input.choices.map((choice, index) => ({ ...choice, id: positionId(index) })),
  );
  if (reading?.verdict !== 'option') return reading;
  const picked = input.choices.find((_, index) => positionId(index) === reading.choiceId);
  return picked ? { verdict: 'option', choiceId: picked.id } : null;
}

export function signupMismatchReadUserMessage(input: {
  text: string;
  askedStart: string | null;
  choices: readonly SiteChoice[];
  labelsFromPage?: boolean;
}): string {
  if (input.labelsFromPage) {
    return JSON.stringify({
      untrusted_asked_start: untrustedPageWords(input.askedStart, SITE_CHOICE_LABEL_MAX_CHARS),
      choices: input.choices.map((choice, index) => ({
        id: positionId(index),
        ...markedSiteChoice(choice),
      })),
      text: input.text.slice(0, 1600),
    });
  }
  return JSON.stringify({
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
      let system: string;
      try {
        skill = await loadCronSkill(SIGNUP_MISMATCH_READ_SKILL);
        system = input.labelsFromPage
          ? `${skill.instructions}\n\n${(await loadCronSkill(SIGNUP_PAGE_WORDS_SKILL)).instructions}`
          : skill.instructions;
      } catch {
        return null;
      }
      try {
        const { value } = await forceToolJson({
          client: resolved,
          lane: pickLane(skill.meta.task),
          system,
          userMessage: signupMismatchReadUserMessage(input),
          toolName: SIGNUP_MISMATCH_READ_TOOL,
          toolDescription: 'Decide which site option the parent picked, if any.',
          inputJsonSchema: SIGNUP_MISMATCH_READ_TOOL_SCHEMA,
          schema: signupMismatchReadSchema,
          maxTokens: SIGNUP_MISMATCH_READ_MAX_TOKENS,
        });
        return mismatchReadingFrom(value, input);
      } catch {
        return null;
      }
    },
  };
}
