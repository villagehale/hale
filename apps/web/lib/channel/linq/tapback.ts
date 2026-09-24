import { LinqSendError, type LinqTapback, reactToLinqMessage } from './transport';

/**
 * VIL-335 — a tapback instead of a throwaway text ack.
 *
 * Only a Linq turn with both ids, and only when the outbound itself is a
 * courtesy with no question, no link, and no kids-year detail. A sentence that
 * tells the parent something keeps its words. SMS never reaches the partner.
 * A refusal is code and status; the caller sends the text so the turn still
 * answers.
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
  if (input.outboundBody.includes('?') || /https?:\/\//i.test(input.outboundBody)) return null;
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
