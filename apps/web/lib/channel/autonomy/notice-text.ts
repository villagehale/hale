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

/**
 * What this kind lets Hale do from now on. Every grantable kind sets at least one
 * flag. False flags stay in the object so a judge can see them, and stay out of
 * the text.
 */
export interface AutonomyMay {
  sendEmail: boolean;
  /** True only when this kind covers replying, not merely sending. */
  replyToEmail: boolean;
  addToCalendar: boolean;
  updateCalendar: boolean;
  moveCalendar: boolean;
  cancelCalendar: boolean;
  sharePhotos: boolean;
  addToDigest: boolean;
  addToRoutine: boolean;
}

/** The one true flag for each kind Hale may do on its own. */
const MAY_TRUE_FLAG = {
  send_email: 'sendEmail',
  reply_to_email: 'replyToEmail',
  create_calendar_event: 'addToCalendar',
  update_calendar_event: 'updateCalendar',
  share_photos_with_family: 'sharePhotos',
  add_to_digest_only: 'addToDigest',
  add_to_routine: 'addToRoutine',
  calendar_add: 'addToCalendar',
  calendar_move: 'moveCalendar',
  calendar_cancel: 'cancelCalendar',
} as const satisfies Record<string, keyof AutonomyMay>;

export const AUTONOMY_MAY_KINDS = Object.keys(MAY_TRUE_FLAG);

function emptyMay(): AutonomyMay {
  return {
    sendEmail: false,
    replyToEmail: false,
    addToCalendar: false,
    updateCalendar: false,
    moveCalendar: false,
    cancelCalendar: false,
    sharePhotos: false,
    addToDigest: false,
    addToRoutine: false,
  };
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

/** Labelled facts from the execution. The writer may reuse these strings. */
export interface ActedNoticeLabel {
  to?: string;
  subject?: string;
  title?: string;
  summary?: string;
}

export interface AutonomyNoticeFacts {
  occasion: AutonomyNoticeOccasion;
  actionType: string;
  /** `users.locale` when it is set. A hint only — never a language this code picked. */
  localeHint: string | null;
  /** The parent's own recent inbound texts, oldest first. */
  recentInbound: string[];
  detail: ActedNoticeLabel | null;
  /**
   * Why the decision was made. Present so the audit is complete in the context.
   * The writer must not quote it. A time or a link that appears only here is invented.
   */
  why: string | null;
}

/** One open notice inside a combined text. */
export interface AutonomyNoticeItem {
  occasion: AutonomyNoticeOccasion;
  actionType: string;
  detail: ActedNoticeLabel | null;
  why: string | null;
  standing: AutonomyNoticeStanding;
}

export interface AutonomyNoticeContext extends AutonomyNoticeFacts {
  standing: AutonomyNoticeStanding;
  /**
   * Every notice this one text covers. Omitted when there is only one, so a
   * single-notice context stays the flat shape the fixtures use.
   */
  items?: AutonomyNoticeItem[];
}

export function noticeStanding(input: {
  occasion: AutonomyNoticeOccasion;
  actionType: string;
}): AutonomyNoticeStanding {
  if (input.occasion === 'acted') {
    return { may: null, never: null, stop: 'one_message' };
  }
  const may = emptyMay();
  const flags: Record<string, keyof AutonomyMay> = MAY_TRUE_FLAG;
  const flag = flags[input.actionType];
  if (flag) may[flag] = true;
  return {
    may,
    never: ['book', 'register', 'pay'],
    stop: 'one_message',
  };
}

export function autonomyNoticeInput(input: AutonomyNoticeFacts): AutonomyNoticeContext {
  return { ...input, standing: noticeStanding(input) };
}

const LABEL_KEYS = ['to', 'subject', 'title', 'summary'] as const;

/**
 * Labelled strings an on-its-own notice may reuse, and the decision reason beside
 * them. The reason is `why`. It is not a label, and it is not a sentence to send.
 */
export function actedNoticeDetail(input: {
  payload: Record<string, unknown> | null;
  reason: string | null;
}): { detail: ActedNoticeLabel | null; why: string | null } {
  const detail: ActedNoticeLabel = {};
  const payload = input.payload ?? {};
  for (const key of LABEL_KEYS) {
    const value = payload[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) detail[key] = trimmed;
  }
  const reason = input.reason?.trim() ?? '';
  return {
    detail: Object.keys(detail).length > 0 ? detail : null,
    why: reason.length > 0 ? reason : null,
  };
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

function labelledSlots(detail: ActedNoticeLabel | null): string[] {
  if (!detail) return [];
  return LABEL_KEYS.flatMap((key) => {
    const value = detail[key];
    return value && value.length > 0 ? [value] : [];
  });
}

function contextItem(input: AutonomyNoticeFacts): AutonomyNoticeItem {
  return {
    occasion: input.occasion,
    actionType: input.actionType,
    detail: input.detail,
    why: input.why,
    standing: noticeStanding(input),
  };
}

function serializedItem(item: AutonomyNoticeItem) {
  return {
    occasion: item.occasion,
    actionType: item.actionType,
    standing: item.standing,
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.why ? { why: item.why } : {}),
  };
}

/**
 * The writer's user message. `standing` is always the computed facts. `detail`
 * and `why` are omitted when empty. `items` is present only when one text covers
 * more than one notice; the top-level fields repeat the first.
 */
export function autonomyNoticeContext(
  input: AutonomyNoticeFacts & { items?: AutonomyNoticeItem[] },
): string {
  const first = input.items && input.items.length > 0 ? input.items[0] : null;
  const occasion = first?.occasion ?? input.occasion;
  const actionType = first?.actionType ?? input.actionType;
  const detail = first ? first.detail : input.detail;
  const why = first ? first.why : input.why;
  const body = {
    occasion,
    actionType,
    localeHint: input.localeHint,
    recentInbound: input.recentInbound,
    standing: first?.standing ?? noticeStanding({ occasion, actionType }),
    ...(detail ? { detail } : {}),
    ...(why ? { why } : {}),
    ...(input.items && input.items.length > 1
      ? { items: input.items.map((item) => serializedItem(item)) }
      : {}),
  };
  return JSON.stringify(body);
}

/**
 * The tool input, checked: one non-empty message, and no time or link the labelled
 * detail did not already contain. `why` is not a slot.
 */
export function readAutonomyNotice(
  value: unknown,
  context: AutonomyNoticeFacts & { items?: AutonomyNoticeItem[] },
): AutonomyNoticeText {
  const parsed = textSchema.safeParse(value);
  if (!parsed.success) return { skipped: 'unparsed' };
  const message = parsed.data.message.trim();
  const items = context.items && context.items.length > 0 ? context.items : [contextItem(context)];
  const slots = [
    context.localeHint ?? '',
    ...context.recentInbound,
    ...items.flatMap((item) => [item.actionType, ...labelledSlots(item.detail)]),
  ].filter((slot) => slot.length > 0);
  if (findInventedFacts(message, slots).length > 0) return { skipped: 'invented' };
  return { message };
}
