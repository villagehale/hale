import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { findInventedFacts } from '~/lib/loop/voice/facts-lint';

/**
 * The turn-on, re-arm, and on-its-own notices. The model writes the text. This
 * module is the tool contract and the checks on what comes back: empty, or a time
 * or a link the context did not give. Tone, and which language, are the eval
 * judge's grade. Nothing here matches a phrase or cuts a text for length.
 */

export const AUTONOMY_NOTICE_TOOL = 'autonomy_notice';
export const AUTONOMY_NOTICE_MAX_TOKENS = 400;

export type AutonomyNoticeOccasion = 'armed' | 'rearmed' | 'acted';

export interface AutonomyNoticeContext {
  occasion: AutonomyNoticeOccasion;
  actionType: string;
  /** `users.locale` when it is set. A hint only — never a language this code picked. */
  localeHint: string | null;
  /** The parent's own recent inbound texts, oldest first. */
  recentInbound: string[];
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

export type AutonomyNoticeSkip = 'no_client' | 'model_failed' | 'unparsed' | 'invented';

export type AutonomyNoticeText = { message: string } | { skipped: AutonomyNoticeSkip };

/** The writer's user message. `detail` is omitted when there is nothing to reuse. */
export function autonomyNoticeContext(input: AutonomyNoticeContext): string {
  return JSON.stringify({
    occasion: input.occasion,
    actionType: input.actionType,
    localeHint: input.localeHint,
    recentInbound: input.recentInbound,
    ...(input.detail ? { detail: input.detail } : {}),
  });
}

/**
 * The tool input, checked: one non-empty message, and no time or link the context
 * did not already contain.
 */
export function readAutonomyNotice(
  value: unknown,
  context: AutonomyNoticeContext,
): AutonomyNoticeText {
  const parsed = textSchema.safeParse(value);
  if (!parsed.success) return { skipped: 'unparsed' };
  const message = parsed.data.message.trim();
  const slots = [
    context.actionType,
    context.localeHint ?? '',
    context.detail ?? '',
    ...context.recentInbound,
  ].filter((slot) => slot.length > 0);
  if (findInventedFacts(message, slots).length > 0) return { skipped: 'invented' };
  return { message };
}
