import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { findInventedFacts } from '../../loop/voice/facts-lint';
import { TEXT_CHARS } from '../proactive/tools';
import type { WeekdayFinderAsk } from './weekday-care-ask';

/**
 * VIL-360 · the weekday-care ask's tool contract and the check on what comes back.
 * Relative imports only, so apps/worker/evals grades the model against this exact file.
 *
 * The ask is one offer, texted the way a friend who noticed something about the family's
 * week would. The model chooses every word, the length and the script; this file refuses
 * only a text that is not the tool's shape, that carries a link or a time nobody gave it,
 * or that runs past one text (`TEXT_CHARS`, the writer's infra bound:
 * WEEKDAY_ASK_MAX_TOKENS bounds tokens, and the Linq door takes far more).
 * Whether the text is the offer that was chosen, in the family's language and tone, is
 * graded by the eval's judge, not counted here.
 */

export const WEEKDAY_ASK_TOOL = 'weekday_ask';
export const WEEKDAY_ASK_MAX_TOKENS = 300;

export const WEEKDAY_ASK_TOOL_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    message: {
      type: 'string',
      description:
        "The one text Hale sends: what a friend who noticed something about this family's week would text, with the one offer in it.",
    },
  },
  required: ['message'],
} satisfies Anthropic.Tool.InputSchema;

const askSchema = z
  .object({ message: z.string().refine((value) => value.trim().length > 0) })
  .strict();

export type WeekdayAskSkip = 'unparsed' | 'invented' | 'over_length';

export type WeekdayAskResult = { message: string } | { skipped: WeekdayAskSkip };

/** The one given word the ask may carry that the facts lint would otherwise read as
 * invented: the child's name, or the break's label. */
function subjectOf(ask: WeekdayFinderAsk): string | null {
  if (ask.prompt === 'after_school_named') return ask.name;
  if (ask.prompt === 'verified_break') return ask.label;
  return null;
}

/**
 * The model sees the prompt, the family's language and the prompt's subject. The child
 * id never leaves the server.
 */
export function weekdayAskContext(ask: WeekdayFinderAsk, language: string): string {
  if (ask.prompt === 'after_school_named') {
    return JSON.stringify({ prompt: ask.prompt, language, name: ask.name });
  }
  if (ask.prompt === 'verified_break') {
    return JSON.stringify({ prompt: ask.prompt, language, label: ask.label });
  }
  return JSON.stringify({ prompt: ask.prompt, language });
}

export function readWeekdayAsk(value: unknown, ask: WeekdayFinderAsk): WeekdayAskResult {
  const parsed = askSchema.safeParse(value);
  if (!parsed.success) return { skipped: 'unparsed' };
  const message = parsed.data.message.trim();
  const subject = subjectOf(ask);
  if (findInventedFacts(message, subject === null ? [] : [subject]).length > 0) {
    return { skipped: 'invented' };
  }
  if (message.length > TEXT_CHARS) return { skipped: 'over_length' };
  return { message };
}
