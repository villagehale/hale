import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';

/**
 * The turn-on, re-arm, and on-its-own notices. The model writes the text. This
 * module is the tool contract and the checks on what comes back: empty, a time or
 * a link the context did not give, or a text too long to be one message. Tone is
 * the eval judge's grade. Nothing here matches a phrase.
 */

export const AUTONOMY_NOTICE_TOOL = 'autonomy_notice';
export const AUTONOMY_NOTICE_MAX_TOKENS = 400;

/** One text. The same bound the proactive writer uses for a message a parent reads. */
export const AUTONOMY_NOTICE_TEXT_CHARS = 640;

export type AutonomyNoticeOccasion = 'armed' | 'rearmed' | 'acted';

export interface AutonomyNoticeContext {
  occasion: AutonomyNoticeOccasion;
  actionType: string;
  language: string;
  detail: string | null;
}

export const AUTONOMY_NOTICE_TOOL_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    message: { type: 'string', description: 'The one text Hale sends.' },
  },
  required: ['message'],
} satisfies Anthropic.Tool.InputSchema;

const textSchema = z
  .object({ message: z.string().refine((value) => value.trim().length > 0) })
  .strict();

export type AutonomyNoticeSkip =
  | 'no_client'
  | 'model_failed'
  | 'unparsed'
  | 'invented'
  | 'over_length';

export type AutonomyNoticeText = { message: string } | { skipped: AutonomyNoticeSkip };

/** The writer's user message. `detail` is omitted when there is nothing to reuse. */
export function autonomyNoticeContext(input: AutonomyNoticeContext): string {
  return JSON.stringify({
    occasion: input.occasion,
    actionType: input.actionType,
    language: input.language,
    ...(input.detail ? { detail: input.detail } : {}),
  });
}

/**
 * The tool input, checked: one non-empty message, no time or link the context did
 * not already contain, and no longer than one text.
 */
export function readAutonomyNotice(
  value: unknown,
  context: AutonomyNoticeContext,
): AutonomyNoticeText {
  const parsed = textSchema.safeParse(value);
  if (!parsed.success) return { skipped: 'unparsed' };
  const message = parsed.data.message.trim();
  const slots = [context.actionType, context.language, context.detail ?? ''].filter(
    (slot) => slot.length > 0,
  );
  if (findInventedFacts(message, slots).length > 0) return { skipped: 'invented' };
  if (message.length > AUTONOMY_NOTICE_TEXT_CHARS) return { skipped: 'over_length' };
  return { message };
}
