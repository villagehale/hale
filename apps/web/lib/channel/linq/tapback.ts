import { isEnabled } from '@hale/flags';
import { reactToLinqMessage } from '~/lib/channel/outbound-transport';
import type { ReplyRoute } from '~/lib/channel/router/reply-route';
import { hasLinkShape } from '~/lib/format/link-shape';
import { isOneEmoji } from './one-emoji';
import { LINQ_TAPBACKS, LinqSendError, type LinqTapback } from './transport';

/**
 * VIL-335 — a tapback instead of a throwaway text ack.
 *
 * Only a Linq turn with both ids, and only when the outbound itself is a
 * courtesy with no question, no link, and no kids-year detail. A sentence that
 * tells the parent something keeps its words. SMS never reaches the partner.
 * A refusal is code and status; the caller sends the text so the turn still
 * answers.
 *
 * VIL-680: only while `LINQ_REACTIONS_ENABLED` is dark for the family. Lit, the coach's
 * own choice (`reactToParentMessage`, below) is the only reaction and these lists are
 * never read.
 */

const LIGHT_INBOUND = new Set([
  'thanks',
  'thank you',
  'ty',
  'ok',
  'okay',
  'k',
  'got it',
  'sounds good',
  'yep',
  'yes',
]);

/** Courtesy the tapback is allowed to stand in for. Anything longer, or with
 * a question or a URL, still needs the words. */
const THROWAWAY_OUTBOUND = new Set([
  'ok',
  'okay',
  'k',
  'got it',
  'thanks',
  'thank you',
  'you are welcome',
  'youre welcome',
  'anytime',
  'sounds good',
]);

export function normalizeTapbackPhrase(body: string): string {
  return body
    .trim()
    .toLowerCase()
    .replace(/[.!]+$/g, '')
    .replace(/['’]/g, '')
    .replace(/\s+/g, ' ');
}

export function decideLinqTapback(input: {
  channel: string;
  chatId: string | null;
  inboundMessageId: string | null;
  inboundBody: string;
  outboundBody: string;
}): { type: LinqTapback } | null {
  if (input.channel !== 'imessage') return null;
  if (!input.chatId || !input.inboundMessageId) return null;
  const inbound = normalizeTapbackPhrase(input.inboundBody);
  const outbound = normalizeTapbackPhrase(input.outboundBody);
  if (!LIGHT_INBOUND.has(inbound) || !THROWAWAY_OUTBOUND.has(outbound)) return null;
  if (input.outboundBody.includes('?') || hasLinkShape(input.outboundBody)) return null;
  if (inbound === 'thanks' || inbound === 'thank you' || inbound === 'ty') return { type: 'like' };
  return { type: 'emphasize' };
}

export type LinqTapbackApply =
  | { status: 'replaced'; type: LinqTapback }
  | {
      status: 'not_replaced';
      reason: 'not_a_moment' | 'refused' | 'not_configured' | 'unreachable';
      code?: string;
      httpStatus?: number;
    };

export async function applyLinqTapback(input: {
  channel: string;
  chatId: string | null;
  inboundMessageId: string | null;
  inboundBody: string;
  outboundBody: string;
  fetch?: typeof fetch;
}): Promise<LinqTapbackApply> {
  const decision = decideLinqTapback(input);
  if (!decision || !input.inboundMessageId)
    return { status: 'not_replaced', reason: 'not_a_moment' };
  try {
    await reactToLinqMessage({
      messageId: input.inboundMessageId,
      operation: 'add',
      type: decision.type,
      fetch: input.fetch,
    });
    return { status: 'replaced', type: decision.type };
  } catch (err) {
    if (err instanceof LinqSendError && err.code === 'not_configured') {
      return { status: 'not_replaced', reason: 'not_configured', code: err.code };
    }
    if (err instanceof LinqSendError && (err.code === 'timeout' || err.code === 'network')) {
      console.warn({ code: err.code }, 'linq tapback: unreachable — the text ack still goes out');
      return { status: 'not_replaced', reason: 'unreachable', code: err.code };
    }
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    const httpStatus = err instanceof LinqSendError ? err.httpStatus : 0;
    console.warn({ code, httpStatus }, 'linq tapback: refused — the text ack still goes out');
    return { status: 'not_replaced', reason: 'refused', code, httpStatus };
  }
}

/**
 * VIL-680 — the model chooses the tapback. Trimmed `true` lights every family; while it
 * is off, `LINQ_REACTIONS_FAMILY_ALLOWLIST` arms the families it names (`linq-reactions`
 * in packages/flags/src/catalog.ts).
 */
export function linqReactionsEnabled(familyId: string): boolean {
  return isEnabled('linq-reactions', familyId);
}

/** A standard iMessage tapback, or one emoji sent as a custom tapback. */
export type ParentReaction = { type: LinqTapback } | { type: 'custom'; emoji: string };

/** What the model named, as Linq can send it, or null when Linq cannot. */
export function readParentReaction(raw: string): ParentReaction | null {
  const value = raw.trim();
  const tapback = LINQ_TAPBACKS.find((type) => type === value);
  if (tapback) return { type: tapback };
  return isOneEmoji(value) ? { type: 'custom', emoji: value } : null;
}

export type ParentReactionSend =
  | { status: 'sent' }
  | {
      status: 'not_sent';
      reason: 'no_parent_message' | 'not_configured' | 'refused' | 'unreachable';
      code?: string;
      httpStatus?: number;
    };

/**
 * The one sender of the model's reaction. It lands on the parent's own inbound message
 * (`route.replyToMessageId`) and takes no other id, so it can never react to one of
 * Hale's. Never throws: every way it did not land is named.
 */
export async function reactToParentMessage(input: {
  route: Extract<ReplyRoute, { channel: 'imessage' }>;
  reaction: ParentReaction;
  fetch?: typeof fetch;
}): Promise<ParentReactionSend> {
  const messageId = input.route.replyToMessageId;
  if (!messageId) return { status: 'not_sent', reason: 'no_parent_message' };
  try {
    await reactToLinqMessage({
      messageId,
      operation: 'add',
      ...(input.reaction.type === 'custom'
        ? { type: 'custom' as const, customEmoji: input.reaction.emoji }
        : { type: input.reaction.type }),
      fetch: input.fetch,
    });
    return { status: 'sent' };
  } catch (err) {
    if (err instanceof LinqSendError && err.code === 'not_configured') {
      return { status: 'not_sent', reason: 'not_configured', code: err.code };
    }
    if (err instanceof LinqSendError && (err.code === 'timeout' || err.code === 'network')) {
      return { status: 'not_sent', reason: 'unreachable', code: err.code };
    }
    const code = err instanceof LinqSendError ? err.code : 'unknown';
    const httpStatus = err instanceof LinqSendError ? err.httpStatus : 0;
    return { status: 'not_sent', reason: 'refused', code, httpStatus };
  }
}
