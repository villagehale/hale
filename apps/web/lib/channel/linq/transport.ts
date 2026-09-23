import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { linqApiKey } from './config';

/**
 * VIL-335 — the outbound Linq leg. Raw `fetch`, no SDK, matching the Twilio
 * transport. Every partner call lives in this file (the one-door scanner).
 *
 * The v1 reply is one text part into the chat the parent just texted:
 * POST /api/partner/v3/chats/{chatId}/messages with `{ message: { parts } }`,
 * threaded under the inbound bubble when we have its message id. Mark-as-read
 * is the same client. Media, tapbacks, and the contact card stay helpers the
 * v1 doors do not call.
 *
 * https://docs.linqapp.com/guides/messaging/sending-messages/
 *
 * Privacy (rule #1): the body and the chat id are arguments, never log lines.
 * A refusal carries Linq's numeric code and the HTTP status only — the error
 * `message` field can echo the text we sent.
 */

const LINQ_API_BASE = 'https://api.linqapp.com/api/partner/v3';

/** Inside Linq's 10s webhook budget when a keyword ack sends inline, and short
 * enough that a hung partner fails the turn instead of holding the instance. */
const SEND_TIMEOUT_MS = 8_000;

const TEXT_MAX = 10_000;
const LINK_MAX = 2_048;

/**
 * A Linq refusal. `code` is Linq's numeric code when they sent one, otherwise a
 * name (`not_configured`, `media_unsupported`, `missing_chat_id`, `timeout`).
 * `permanent` means a retry would earn the same refusal.
 */
export class LinqSendError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly permanent: boolean;

  constructor(code: string, httpStatus: number, permanent: boolean) {
    super(`linq send failed: ${code}`);
    this.name = 'LinqSendError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.permanent = permanent;
  }
}

/** Standard iMessage tapbacks. `custom` carries the emoji in `customEmoji`. */
export const LINQ_TAPBACKS = ['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'] as const;
export type LinqTapback = (typeof LINQ_TAPBACKS)[number];

export type LinqOutboundPart =
  | { type: 'text'; value: string }
  | { type: 'media'; url: string }
  | { type: 'media'; attachmentId: string }
  | { type: 'link'; value: string };

/** Thread a follow-up under a message the parent already has. `partIndex` is
 * 0-based and optional — Linq defaults it to the first part. */
export interface LinqReplyTarget {
  messageId: string;
  partIndex?: number;
}

/** A presence or card call that must not fail the turn it decorates. */
export type LinqEffectResult =
  | { status: 'accepted' }
  | { status: 'not_configured' }
  | { status: 'refused'; code: string; httpStatus: number; permanent: boolean }
  | { status: 'unreachable'; reason: 'timeout' | 'network' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function linqErrorCode(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.error)) return null;
  const code = payload.error.code;
  if (typeof code === 'number' || typeof code === 'string') return String(code);
  return null;
}

/** The message id on a 2xx, across the send-to-chat shape (`message.id`) and the
 * create-chat shape (`last_message.id`). Null when the body does not carry one. */
export function readLinqMessageId(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const key of ['message', 'last_message'] as const) {
    const message = payload[key];
    if (isRecord(message) && typeof message.id === 'string' && message.id) return message.id;
  }
  return null;
}

type LinqHttpResult = {
  status: number;
  payload: unknown;
  code: string;
  permanent: boolean;
  ok: boolean;
};

async function linqRequest(input: {
  method: 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  fetch?: typeof fetch;
}): Promise<LinqHttpResult> {
  const apiKey = linqApiKey();
  if (!apiKey) throw new LinqSendError('not_configured', 0, true);

  const doFetch = input.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(`${LINQ_API_BASE}${input.path}`, {
      method: input.method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new LinqSendError(aborted ? 'timeout' : 'network', 0, false);
  } finally {
    clearTimeout(timer);
  }

  const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
  return {
    ok: response.ok,
    status: response.status,
    payload,
    code: linqErrorCode(payload) ?? `http_${response.status}`,
    permanent,
  };
}

/** Typing, and anything else whose failure must be a named result rather than a
 * lost reply. Throws only on a bug. */
async function linqEffect(input: {
  method: 'POST' | 'DELETE';
  path: string;
  body?: unknown;
  fetch?: typeof fetch;
}): Promise<LinqEffectResult> {
  try {
    const result = await linqRequest(input);
    if (!result.ok) {
      return {
        status: 'refused',
        code: result.code,
        httpStatus: result.status,
        permanent: result.permanent,
      };
    }
    return { status: 'accepted' };
  } catch (err) {
    if (err instanceof LinqSendError && err.code === 'not_configured') {
      return { status: 'not_configured' };
    }
    if (err instanceof LinqSendError && (err.code === 'timeout' || err.code === 'network')) {
      return { status: 'unreachable', reason: err.code };
    }
    throw err;
  }
}

function wirePart(part: LinqOutboundPart): Record<string, string> {
  if (part.type === 'text') return { type: 'text', value: part.value };
  if (part.type === 'link') return { type: 'link', value: part.value };
  if ('attachmentId' in part && part.attachmentId) {
    return { type: 'media', attachment_id: part.attachmentId };
  }
  if ('url' in part && part.url) return { type: 'media', url: part.url };
  throw new LinqSendError('invalid_parts', 400, true);
}

/** Linq rejects a link preview that shares a message with anything else, and
 * rejects two text parts in a row. Checked here so a caller finds out before
 * the partner does. */
function assertParts(parts: readonly LinqOutboundPart[]): void {
  if (parts.length === 0 || parts.length > 100) {
    throw new LinqSendError('invalid_parts', 400, true);
  }
  const linkCount = parts.filter((part) => part.type === 'link').length;
  if (linkCount > 0 && parts.length !== 1) {
    throw new LinqSendError('link_not_alone', 400, true);
  }
  for (let i = 1; i < parts.length; i += 1) {
    if (parts[i]?.type === 'text' && parts[i - 1]?.type === 'text') {
      throw new LinqSendError('consecutive_text', 400, true);
    }
  }
  for (const part of parts) {
    if (part.type === 'text' && (part.value.length === 0 || part.value.length > TEXT_MAX)) {
      throw new LinqSendError('invalid_parts', 400, true);
    }
    if (part.type === 'link' && (part.value.length === 0 || part.value.length > LINK_MAX)) {
      throw new LinqSendError('invalid_parts', 400, true);
    }
  }
}

/**
 * Send parts into an existing chat. `replyTo` threads the message under a
 * previous one. Link parts must be the only part — they render as a rich
 * preview. Media is a public `url` or a pre-uploaded `attachmentId`.
 */
export async function sendLinqParts(input: {
  chatId: string;
  parts: readonly LinqOutboundPart[];
  replyTo?: LinqReplyTarget;
  fetch?: typeof fetch;
}): Promise<{ providerMessageId: string }> {
  assertParts(input.parts);
  if (input.replyTo && !input.replyTo.messageId) {
    throw new LinqSendError('invalid_parts', 400, true);
  }
  const message: Record<string, unknown> = { parts: input.parts.map(wirePart) };
  if (input.replyTo) {
    message.reply_to = {
      message_id: input.replyTo.messageId,
      ...(input.replyTo.partIndex !== undefined ? { part_index: input.replyTo.partIndex } : {}),
    };
  }
  const result = await linqRequest({
    method: 'POST',
    path: `/chats/${encodeURIComponent(input.chatId)}/messages`,
    body: { message },
    fetch: input.fetch,
  });
  if (!result.ok) throw new LinqSendError(result.code, result.status, result.permanent);
  const providerMessageId = readLinqMessageId(result.payload);
  if (!providerMessageId) throw new LinqSendError('missing_message_id', result.status, false);
  return { providerMessageId };
}

/**
 * One text bubble into an existing chat. `replyTo` threads it under the
 * parent's bubble. A permanent refusal of that target (Linq 4xx) is logged and
 * the same text is sent plain — the answer is what the parent is owed, and a
 * thread target Linq will not accept must not swallow it. A missing key, a
 * local parts rejection, or a retryable outage still throws: those are not
 * "reply_to was the problem".
 */
export async function sendLinqChatMessage(input: {
  chatId: string;
  text: string;
  replyTo?: LinqReplyTarget;
  fetch?: typeof fetch;
}): Promise<{ providerMessageId: string }> {
  const send = (replyTo?: LinqReplyTarget) =>
    sendLinqParts({
      chatId: input.chatId,
      parts: [{ type: 'text', value: input.text }],
      replyTo,
      fetch: input.fetch,
    });
  try {
    return await send(input.replyTo);
  } catch (err) {
    if (
      !input.replyTo ||
      !(err instanceof LinqSendError) ||
      !err.permanent ||
      err.httpStatus < 400
    ) {
      throw err;
    }
    // Code and status only. The body and the chat id stay out of the log (rule #1).
    console.warn(
      { code: err.code, httpStatus: err.httpStatus },
      'linq: reply_to refused — sending the answer without a thread target',
    );
    return await send();
  }
}

/**
 * Mark the chat read so the parent's bubble shows a read receipt. iMessage
 * one-to-one only; Linq accepts the call on a group and delivers nothing.
 * Best-effort: a miss is a named result, never a thrown turn.
 *
 * https://docs.linqapp.com/api/resources/chats/methods/mark_as_read/
 */
export function markLinqChatRead(input: {
  chatId: string;
  fetch?: typeof fetch;
}): Promise<LinqEffectResult> {
  return linqEffect({
    method: 'POST',
    path: `/chats/${encodeURIComponent(input.chatId)}/read`,
    fetch: input.fetch,
  });
}

/**
 * Show the typing bubble. iMessage only; Linq accepts the call for other
 * protocols and delivers nothing. One call lasts about 85 seconds — refresh
 * every 60 (presence.ts) while the turn is still thinking. Sending a message
 * clears it; stop explicitly when the turn will not send.
 *
 * https://docs.linqapp.com/channel/imessage/api/resources/chats/subresources/typing/methods/start/
 */
export function startLinqTyping(input: {
  chatId: string;
  fetch?: typeof fetch;
}): Promise<LinqEffectResult> {
  return linqEffect({
    method: 'POST',
    path: `/chats/${encodeURIComponent(input.chatId)}/typing`,
    fetch: input.fetch,
  });
}

/** Clear the bubble without sending. A message send also clears it; this is
 * the path for a turn that thought and then had nothing to say. */
export function stopLinqTyping(input: {
  chatId: string;
  fetch?: typeof fetch;
}): Promise<LinqEffectResult> {
  return linqEffect({
    method: 'DELETE',
    path: `/chats/${encodeURIComponent(input.chatId)}/typing`,
    fetch: input.fetch,
  });
}

/**
 * Add or remove a tapback on a message the parent already has. Not called from
 * the v1 reply path — a reaction is a product decision, and this helper is the
 * transport for it.
 *
 * https://docs.linqapp.com/api/resources/messages/methods/add_reaction/
 */
export async function reactToLinqMessage(input: {
  messageId: string;
  operation: 'add' | 'remove';
  type: LinqTapback | 'custom';
  customEmoji?: string;
  partIndex?: number;
  fetch?: typeof fetch;
}): Promise<{ accepted: true }> {
  if (input.type === 'custom' && !input.customEmoji?.trim()) {
    throw new LinqSendError('invalid_reaction', 400, true);
  }
  const body: Record<string, unknown> = {
    operation: input.operation,
    type: input.type,
  };
  if (input.type === 'custom' && input.customEmoji) body.custom_emoji = input.customEmoji;
  if (input.partIndex !== undefined) body.part_index = input.partIndex;
  const result = await linqRequest({
    method: 'POST',
    path: `/messages/${encodeURIComponent(input.messageId)}/reactions`,
    body,
    fetch: input.fetch,
  });
  if (!result.ok) throw new LinqSendError(result.code, result.status, result.permanent);
  return { accepted: true };
}

/**
 * Push the Name and Photo card already configured on the sending line. iMessage
 * only, and only after at least one outbound message. NOT called from the v1
 * inbound path — sharing a card unasked is a spam, and the card itself is set
 * up in the Linq dashboard, not here.
 *
 * https://docs.linqapp.com/guides/chats/share-contact-card/
 */
export async function shareLinqContactCard(input: {
  chatId: string;
  fetch?: typeof fetch;
}): Promise<{ accepted: true }> {
  const result = await linqRequest({
    method: 'POST',
    path: `/chats/${encodeURIComponent(input.chatId)}/share_contact_card`,
    fetch: input.fetch,
  });
  if (!result.ok) throw new LinqSendError(result.code, result.status, result.permanent);
  return { accepted: true };
}

/**
 * The intake-shaped transport for one iMessage turn, bound to the chat the
 * parent just texted. `mediaUrls` still throws: that argument is the welcome
 * vCard, which this leg does not know how to render, and dropping it would tell
 * the parent a card arrived. A later caller with a public image URL uses
 * `sendLinqParts` instead.
 */
export function createLinqTextTransport(deps: {
  chatId: string | null;
  /** The inbound Linq message this turn is answering. Absent sends a plain bubble. */
  replyToMessageId?: string | null;
  fetch?: typeof fetch;
}): ChannelTransport {
  return {
    async send(input) {
      if (input.mediaUrls) {
        throw new LinqSendError('media_unsupported', 400, true);
      }
      if (!deps.chatId) throw new LinqSendError('missing_chat_id', 400, true);
      const sent = await sendLinqChatMessage({
        chatId: deps.chatId,
        text: input.body,
        replyTo: deps.replyToMessageId ? { messageId: deps.replyToMessageId } : undefined,
        fetch: deps.fetch,
      });
      return {
        providerMessageId: sent.providerMessageId,
        transport: 'imessage',
        chatId: deps.chatId,
      };
    },
  };
}
