import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { findInventedFacts } from '../../loop/voice/facts-lint';
import { isPrintableGsm7Basic, smsSegments } from '../sms-segments';
import { MAX_NUDGE_SEGMENTS, NUDGE_OPT_OUT } from './shell';
import type { WeekdayFinderAsk } from './weekday-care-ask';

/**
 * VIL-360 · the weekday-care ask's tool contract and the check on what comes back.
 * Relative imports only, so apps/worker/evals grades the model against this exact file.
 *
 * The ask is a yes-or-no offer. The model writes it; this file decides whether what it
 * wrote is the offer that was chosen: one question, the subject the prompt names, no
 * link or time nobody gave it, and the nudge segment budget.
 */

export const WEEKDAY_ASK_TOOL = 'weekday_ask';
export const WEEKDAY_ASK_MAX_TOKENS = 300;

export const WEEKDAY_ASK_TOOL_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    message: { type: 'string', description: 'The one text Hale sends: a single yes-or-no offer.' },
  },
  required: ['message'],
} satisfies Anthropic.Tool.InputSchema;

const askSchema = z
  .object({ message: z.string().refine((value) => value.trim().length > 0) })
  .strict();

export type WeekdayAskSkip =
  | 'unparsed'
  | 'not_one_question'
  | 'not_gsm7'
  | 'missing_subject'
  | 'invented'
  | 'too_long';

export type WeekdayAskResult = { message: string } | { skipped: WeekdayAskSkip };

/** The words the ask must carry for the prompt it answers: the child, or the break. */
function subjectOf(ask: WeekdayFinderAsk): string | null {
  if (ask.prompt === 'after_school_named') return ask.name;
  if (ask.prompt === 'verified_break') return ask.label;
  return null;
}

/** The model sees the prompt and its subject. The child id never leaves the server. */
export function weekdayAskContext(ask: WeekdayFinderAsk): string {
  if (ask.prompt === 'after_school_named') {
    return JSON.stringify({ prompt: ask.prompt, name: ask.name });
  }
  if (ask.prompt === 'verified_break') {
    return JSON.stringify({ prompt: ask.prompt, label: ask.label });
  }
  return JSON.stringify({ prompt: ask.prompt });
}

export function readWeekdayAsk(value: unknown, ask: WeekdayFinderAsk): WeekdayAskResult {
  const parsed = askSchema.safeParse(value);
  if (!parsed.success) return { skipped: 'unparsed' };
  const message = parsed.data.message.trim();
  if ((message.match(/\?/g) ?? []).length !== 1) return { skipped: 'not_one_question' };
  if (!isPrintableGsm7Basic(message)) return { skipped: 'not_gsm7' };
  const subject = subjectOf(ask);
  if (subject !== null && !message.toLowerCase().includes(subject.toLowerCase())) {
    return { skipped: 'missing_subject' };
  }
  if (findInventedFacts(message, subject === null ? [] : [subject]).length > 0) {
    return { skipped: 'invented' };
  }
  if (smsSegments(`${message}\n\n${NUDGE_OPT_OUT}`) > MAX_NUDGE_SEGMENTS) {
    return { skipped: 'too_long' };
  }
  return { message };
}
