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

/** What this kind lets Hale do from now on. False flags are left out of the text. */
export interface AutonomyMay {
  sendEmail: boolean;
  /** True only when this kind covers replying, not merely sending. */
  replyToEmail: boolean;
  addToCalendar: boolean;
}

/**
 * Facts the writer must convey. Computed here so a fixture cannot leave them off.
 * An on-its-own notice carries the stop fact only: what was just done is `detail`.
 */
export interface AutonomyNoticeStanding {
  may: AutonomyMay | null;
  never: readonly ['book', 'register', 'pay'] | null;
  stop: 'one_message';
}

export interface AutonomyNoticeFacts {
  occasion: AutonomyNoticeOccasion;
  actionType: string;
  /** `users.locale` when it is set. A hint only — never a language this code picked. */
  localeHint: string | null;
  /** The parent's own recent inbound texts, oldest first. */
  recentInbound: string[];
  detail: string | null;
}

export interface AutonomyNoticeContext extends AutonomyNoticeFacts {
  standing: AutonomyNoticeStanding;
}

export function noticeStanding(input: {
  occasion: AutonomyNoticeOccasion;
  actionType: string;
}): AutonomyNoticeStanding {
  if (input.occasion === 'acted') {
    return { may: null, never: null, stop: 'one_message' };
  }
  return {
    may: {
      sendEmail: input.actionType === 'send_email',
      replyToEmail: input.actionType === 'reply_to_email',
      addToCalendar:
        input.actionType === 'calendar_add' || input.actionType === 'create_calendar_event',
    },
    never: ['book', 'register', 'pay'],
    stop: 'one_message',
  };
}

export function autonomyNoticeInput(input: AutonomyNoticeFacts): AutonomyNoticeContext {
  return { ...input, standing: noticeStanding(input) };
}

/**
 * The only strings an on-its-own notice may reuse: fields the execution already
 * stored, plus the decision reason. Nothing here is a sentence to send.
 */
export function actedNoticeDetail(input: {
  payload: Record<string, unknown> | null;
  reason: string | null;
}): string | null {
  const parts: string[] = [];
  const payload = input.payload ?? {};
  for (const key of ['to', 'subject', 'title', 'summary'] as const) {
    const value = payload[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) parts.push(trimmed);
  }
  const reason = input.reason?.trim() ?? '';
  if (reason.length > 0) parts.push(reason);
  return parts.length > 0 ? parts.join('\n') : null;
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

/**
 * The writer's user message. `standing` is always the computed facts, and
 * `detail` is omitted when there is nothing to reuse.
 */
export function autonomyNoticeContext(input: AutonomyNoticeFacts): string {
  return JSON.stringify({
    occasion: input.occasion,
    actionType: input.actionType,
    localeHint: input.localeHint,
    recentInbound: input.recentInbound,
    standing: noticeStanding(input),
    ...(input.detail ? { detail: input.detail } : {}),
  });
}

/**
 * The tool input, checked: one non-empty message, and no time or link the context
 * did not already contain.
 */
export function readAutonomyNotice(
  value: unknown,
  context: AutonomyNoticeFacts,
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
