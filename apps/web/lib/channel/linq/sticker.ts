import type { AgentClient } from '@hale/agent';
import { pickLane } from '@hale/agent';
import { z } from 'zod';
import type { InboundMediaKind } from '~/lib/channel/inbound-media';
import { loadCronSkill } from '~/lib/cron/skill';
import { HOT_SMS_CLIENT_OPTIONS, budgetedAnthropic } from '~/lib/pipeline/client';
import { forceToolJson } from '~/lib/pipeline/structured';
import { LinqSendError, peelLinqSticker } from './transport';

/**
 * VIL-472 — a sticker peeled onto the parent's message, when the model says one fits.
 *
 * Behind `LINQ_STICKERS_ENABLED`, exactly `true` (default off). The `linq-sticker` skill
 * reads the parent's message and the reply Hale already wrote, and returns the emoji (or
 * none) and whether the written reply still goes out. Code never picks an emoji and has no
 * fallback one: a failed or unusable read peels nothing, and the reply goes out as it
 * would have without this feature.
 */

export function linqStickersEnabled(): boolean {
  return process.env.LINQ_STICKERS_ENABLED?.trim() === 'true';
}

export interface LinqStickerInput {
  audience: 'direct' | 'group';
  parentText: string;
  parentAttachments: readonly InboundMediaKind[];
  reply: string;
}

export interface LinqStickerDecision {
  sticker: string | null;
  sendReply: boolean;
}

export interface LinqStickerDecider {
  /** Null: the read failed or came back unusable. Nothing is peeled. */
  decide(input: LinqStickerInput): Promise<LinqStickerDecision | null>;
}

export const LINQ_STICKER_TOOL = 'linq_sticker';
export const LINQ_STICKER_MAX_TOKENS = 400;
export const LINQ_STICKER_TOOL_SCHEMA = {
  type: 'object',
  properties: {
    sticker: { type: ['string', 'null'] },
    sendReply: { type: 'boolean' },
  },
  required: ['sticker', 'sendReply'],
} as const;

const outputSchema = z.object({
  sticker: z.string().nullable(),
  sendReply: z.boolean(),
});

/** The user-turn payload. Shared with the eval, which replays this request shape. */
export function linqStickerUserMessage(input: LinqStickerInput): string {
  return JSON.stringify({
    audience: input.audience,
    parent: { text: input.parentText, attachments: [...input.parentAttachments] },
    reply: input.reply,
  });
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

/**
 * Why a reading cannot be acted on. Linq's peel takes exactly one emoji, and a turn
 * that drops the reply must leave a sticker in its place. Neither is a judgement
 * about wording; both are what the send can carry.
 */
export type LinqStickerRefusal = 'not_one_emoji' | 'silent_turn';

export function linqStickerRefusals(decision: LinqStickerDecision): LinqStickerRefusal[] {
  const refusals: LinqStickerRefusal[] = [];
  if (decision.sticker !== null) {
    const graphemes = [...segmenter.segment(decision.sticker)];
    if (graphemes.length !== 1 || !PICTOGRAPH.test(decision.sticker)) {
      refusals.push('not_one_emoji');
    }
  }
  if (!decision.sendReply && decision.sticker === null) refusals.push('silent_turn');
  return refusals;
}

export function createLinqStickerDecider(
  clientOrResolver: AgentClient | (() => AgentClient),
): LinqStickerDecider {
  return {
    async decide(input) {
      try {
        const client =
          typeof clientOrResolver === 'function' ? clientOrResolver() : clientOrResolver;
        const skill = await loadCronSkill('linq-sticker');
        const { value } = await forceToolJson({
          client,
          lane: pickLane(skill.meta.task),
          system: skill.instructions,
          userMessage: linqStickerUserMessage(input),
          toolName: LINQ_STICKER_TOOL,
          toolDescription: 'Return the sticker to peel, or null, and whether the reply still goes.',
          inputJsonSchema: LINQ_STICKER_TOOL_SCHEMA,
          schema: outputSchema,
          maxTokens: LINQ_STICKER_MAX_TOKENS,
        });
        const refusals = linqStickerRefusals(value);
        if (refusals.length > 0) {
          console.warn({ refusals }, 'linq sticker: reading unusable, nothing peeled');
          return null;
        }
        return value;
      } catch (err) {
        console.warn(
          { err: err instanceof Error ? err.name : 'unknown' },
          'linq sticker: read failed, nothing peeled',
        );
        return null;
      }
    },
  };
}

let shared: LinqStickerDecider | null = null;

export function sharedLinqStickerDecider(): LinqStickerDecider {
  shared ??= createLinqStickerDecider(() => budgetedAnthropic(HOT_SMS_CLIENT_OPTIONS));
  return shared;
}

export type LinqStickerOutcome =
  | { status: 'peeled'; sticker: string; sendReply: boolean }
  | { status: 'declined' }
  | {
      status: 'not_peeled';
      reason: 'model_failed' | 'refused' | 'not_configured' | 'unreachable';
      code?: string;
      httpStatus?: number;
    };

/** Ask the model, then peel what it chose onto the parent's message. Never throws. */
export async function applyLinqSticker(input: {
  decider: LinqStickerDecider;
  inboundMessageId: string;
  read: LinqStickerInput;
  fetch?: typeof fetch;
}): Promise<LinqStickerOutcome> {
  const decision = await input.decider.decide(input.read);
  if (!decision) return { status: 'not_peeled', reason: 'model_failed' };
  if (decision.sticker === null) return { status: 'declined' };
  try {
    await peelLinqSticker({
      messageId: input.inboundMessageId,
      emoji: decision.sticker,
      fetch: input.fetch,
    });
    return { status: 'peeled', sticker: decision.sticker, sendReply: decision.sendReply };
  } catch (err) {
    if (err instanceof LinqSendError && err.code === 'not_configured') {
      console.warn({ reason: 'not_configured' }, 'linq sticker: not peeled');
      return { status: 'not_peeled', reason: 'not_configured', code: err.code };
    }
    if (err instanceof LinqSendError && (err.code === 'timeout' || err.code === 'network')) {
      console.warn({ code: err.code }, 'linq sticker: unreachable, the reply still goes out');
      return { status: 'not_peeled', reason: 'unreachable', code: err.code };
    }
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    const httpStatus = err instanceof LinqSendError ? err.httpStatus : 0;
    console.warn({ code, httpStatus }, 'linq sticker: refused, the reply still goes out');
    return { status: 'not_peeled', reason: 'refused', code, httpStatus };
  }
}
