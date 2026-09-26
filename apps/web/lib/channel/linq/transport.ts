import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { linqApiKey } from './config';

/**
 * VIL-335 — the outbound Linq leg. Raw `fetch`, no SDK, matching the Twilio
 * transport. Every partner call lives in this file (the one-door scanner).
 *
 * The v1 reply is one text part into the chat the parent just texted:
 * POST /api/partner/v3/chats/{chatId}/messages with `{ message: { parts } }`,
 * threaded under the inbound bubble when we have its message id. Mark-as-read
 * is the same client. Tapbacks, link parts, the contact card, groups, polls,
 * and effects are the same client; product moments call them from the sibling
 * modules, not from a door that has not decided to.
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
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
 * only, and only after at least one outbound message. Hale calls this once,
 * after the first successful 1:1 outbound. The call is silent: no chat bubble.
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
  // A 2xx body that says the share did not happen is a no-op. Callers must not
  // audit it as delivered. An empty 2xx is the documented success (the SDK
  // returns void) and is accepted only after the card was confirmed active.
  if (isRecord(result.payload) && result.payload.success === false) {
    throw new LinqSendError(
      linqErrorCode(result.payload) ?? 'share_noop',
      result.status,
      result.permanent,
    );
  }
  return { accepted: true };
}

/** The chat id on a create-chat body (`chat.id`). Null when the body has none. */
export function readLinqChatId(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.chat)) return null;
  const id = payload.chat.id;
  return typeof id === 'string' && id ? id : null;
}

/** Message id nested under a create-chat body (`chat.message.id`). */
export function readLinqCreatedMessageId(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.chat)) return null;
  return readLinqMessageId({ message: payload.chat.message });
}

export interface LinqPollOptionRef {
  optionId: string;
  text: string;
}

/** The poll envelope: the definition message, and each option id Linq minted. */
export function readLinqPollEnvelope(
  payload: unknown,
): { messageId: string; options: LinqPollOptionRef[] } | null {
  if (!isRecord(payload)) return null;
  const messageId = typeof payload.message_id === 'string' ? payload.message_id : '';
  const poll = payload.poll;
  if (!messageId || !isRecord(poll) || !Array.isArray(poll.options)) return null;
  const options: LinqPollOptionRef[] = [];
  for (const option of poll.options) {
    if (!isRecord(option)) continue;
    const optionId = typeof option.option_id === 'string' ? option.option_id : '';
    const text = typeof option.text === 'string' ? option.text : '';
    if (optionId && text) options.push({ optionId, text });
  }
  if (options.length < 2) return null;
  return { messageId, options };
}

/** Non-me handles on a chat payload. Phones stay in the return value for the
 * caller to hash; this function does not log them. */
export function readLinqChatHandles(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const chat = isRecord(payload.chat) ? payload.chat : payload;
  const handles = Array.isArray(chat.handles) ? chat.handles : [];
  const out: string[] = [];
  for (const handle of handles) {
    if (!isRecord(handle) || handle.is_me === true) continue;
    if (typeof handle.handle === 'string' && handle.handle) out.push(handle.handle);
  }
  return out;
}

/**
 * Open a chat. Two or more `to` handles make it a group. The first message
 * cannot contain a link — Linq rejects `link` parts and text that contains a
 * URL on this endpoint. Effects and `reply_to` are likewise refused here.
 *
 * https://docs.linqapp.com/guides/chats/group-chats/
 */
export async function createLinqChat(input: {
  from: string;
  to: readonly string[];
  text: string;
  fetch?: typeof fetch;
}): Promise<{ chatId: string; providerMessageId: string }> {
  if (input.to.length < 1) throw new LinqSendError('invalid_recipients', 400, true);
  if (!input.text.trim() || /https?:\/\//i.test(input.text)) {
    throw new LinqSendError('invalid_parts', 400, true);
  }
  const result = await linqRequest({
    method: 'POST',
    path: '/chats',
    body: {
      from: input.from,
      to: [...input.to],
      message: { parts: [{ type: 'text', value: input.text }] },
    },
    fetch: input.fetch,
  });
  if (!result.ok) throw new LinqSendError(result.code, result.status, result.permanent);
  const chatId = readLinqChatId(result.payload);
  const providerMessageId = readLinqCreatedMessageId(result.payload);
  if (!chatId || !providerMessageId) {
    throw new LinqSendError('missing_chat_id', result.status, false);
  }
  return { chatId, providerMessageId };
}

/** Group display name and icon. Linq returns 1006 on a 1:1 chat. */
export async function updateLinqGroupChat(input: {
  chatId: string;
  displayName?: string;
  iconUrl?: string;
  fetch?: typeof fetch;
}): Promise<LinqEffectResult> {
  const body: Record<string, string> = {};
  if (input.displayName) body.display_name = input.displayName;
  if (input.iconUrl) body.group_chat_icon = input.iconUrl;
  if (Object.keys(body).length === 0) {
    return { status: 'refused', code: 'invalid_parts', httpStatus: 400, permanent: true };
  }
  return linqEffect({
    method: 'PUT',
    path: `/chats/${encodeURIComponent(input.chatId)}`,
    body,
    fetch: input.fetch,
  });
}

/** GET the chat and return the other participants' handles. A miss is named. */
export async function listLinqParticipantHandles(input: {
  chatId: string;
  fetch?: typeof fetch;
}): Promise<
  { status: 'ok'; handles: string[] } | Exclude<LinqEffectResult, { status: 'accepted' }>
> {
  try {
    const result = await linqRequest({
      method: 'GET',
      path: `/chats/${encodeURIComponent(input.chatId)}`,
      fetch: input.fetch,
    });
    if (!result.ok) {
      return {
        status: 'refused',
        code: result.code,
        httpStatus: result.status,
        permanent: result.permanent,
      };
    }
    return { status: 'ok', handles: readLinqChatHandles(result.payload) };
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

/**
 * Add a participant to an existing iMessage group. The new handle has to be on
 * the same service as the group; Linq's sandbox also requires they have texted
 * the line first. A refusal is a thrown `LinqSendError` so the caller can name
 * the degrade.
 *
 * https://docs.linqapp.com/guides/chats/group-chats/
 */
export async function addLinqParticipant(input: {
  chatId: string;
  handle: string;
  fetch?: typeof fetch;
}): Promise<{ accepted: true }> {
  if (!input.handle.trim()) throw new LinqSendError('invalid_recipients', 400, true);
  const result = await linqRequest({
    method: 'POST',
    path: `/chats/${encodeURIComponent(input.chatId)}/participants`,
    body: { handle: input.handle },
    fetch: input.fetch,
  });
  if (!result.ok) throw new LinqSendError(result.code, result.status, result.permanent);
  return { accepted: true };
}

/** Remove a participant. The group must still have 3 members afterwards. */
export async function removeLinqParticipant(input: {
  chatId: string;
  handle: string;
  fetch?: typeof fetch;
}): Promise<{ accepted: true }> {
  if (!input.handle.trim()) throw new LinqSendError('invalid_recipients', 400, true);
  const result = await linqRequest({
    method: 'DELETE',
    path: `/chats/${encodeURIComponent(input.chatId)}/participants`,
    body: { handle: input.handle },
    fetch: input.fetch,
  });
  if (!result.ok) throw new LinqSendError(result.code, result.status, result.permanent);
  return { accepted: true };
}

const CONTACT_CARD_ALREADY_ACTIVE = '2014';

/**
 * Create the Name and Photo card on the sending line, or refresh it when one
 * is already active (Linq 409 / 2014). `firstName` is the name iMessage shows.
 * Linq has no organization field. `imageUrl` must be a public HTTPS image;
 * Linq rehosts it. A local path is not a card photo.
 *
 * https://docs.linqapp.com/guides/contact-cards/
 */
export async function setupLinqContactCard(input: {
  phoneNumber: string;
  firstName: string;
  imageUrl: string;
  fetch?: typeof fetch;
}): Promise<LinqEffectResult> {
  if (!input.phoneNumber || !input.firstName || !input.imageUrl.startsWith('https://')) {
    return { status: 'refused', code: 'invalid_contact_card', httpStatus: 400, permanent: true };
  }
  const body = {
    first_name: input.firstName,
    phone_number: input.phoneNumber,
    image_url: input.imageUrl,
  };
  try {
    const created = await linqRequest({
      method: 'POST',
      path: '/contact_card',
      body,
      fetch: input.fetch,
    });
    if (created.ok) return contactCardActive(created.payload, input.phoneNumber);
    if (created.code !== CONTACT_CARD_ALREADY_ACTIVE) {
      return {
        status: 'refused',
        code: created.code,
        httpStatus: created.status,
        permanent: created.permanent,
      };
    }
    const patched = await linqRequest({
      method: 'PATCH',
      path: `/contact_card?phone_number=${encodeURIComponent(input.phoneNumber)}`,
      body: { first_name: input.firstName, image_url: input.imageUrl },
      fetch: input.fetch,
    });
    if (!patched.ok) {
      return {
        status: 'refused',
        code: patched.code,
        httpStatus: patched.status,
        permanent: patched.permanent,
      };
    }
    return contactCardActive(patched.payload, input.phoneNumber);
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

/**
 * True only when this payload says the card for `phoneNumber` is live.
 * A missing `is_active` is not live: Linq stores the card inactive first, and
 * a 2xx with no flag used to be treated as applied.
 */
export function contactCardIsLive(payload: unknown, phoneNumber: string): boolean {
  const want = phoneNumber.trim();
  for (const card of readContactCards(payload)) {
    if (card.isActive !== true) continue;
    if (!card.phone || card.phone === want) return true;
  }
  return false;
}

function readContactCards(payload: unknown): { phone: string | null; isActive: boolean | null }[] {
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.contact_cards)) {
    return payload.contact_cards.flatMap((card) => {
      if (!isRecord(card)) return [];
      return [
        {
          phone: typeof card.phone_number === 'string' ? card.phone_number : null,
          isActive: typeof card.is_active === 'boolean' ? card.is_active : null,
        },
      ];
    });
  }
  if (!('is_active' in payload) && !('phone_number' in payload)) return [];
  return [
    {
      phone: typeof payload.phone_number === 'string' ? payload.phone_number : null,
      isActive: typeof payload.is_active === 'boolean' ? payload.is_active : null,
    },
  ];
}

function contactCardActive(payload: unknown, phoneNumber: string): LinqEffectResult {
  if (contactCardIsLive(payload, phoneNumber)) return { status: 'accepted' };
  return { status: 'refused', code: 'card_inactive', httpStatus: 200, permanent: false };
}

/** GET the card Linq has for this line. Share only after this says active. */
export async function retrieveLinqContactCard(input: {
  phoneNumber: string;
  fetch?: typeof fetch;
}): Promise<
  | { status: 'active' }
  | { status: 'inactive' }
  | { status: 'not_configured' }
  | { status: 'refused'; code: string; httpStatus: number }
  | { status: 'unreachable' }
> {
  try {
    const result = await linqRequest({
      method: 'GET',
      path: `/contact_card?phone_number=${encodeURIComponent(input.phoneNumber)}`,
      fetch: input.fetch,
    });
    if (!result.ok) {
      return { status: 'refused', code: result.code, httpStatus: result.status };
    }
    return contactCardIsLive(result.payload, input.phoneNumber)
      ? { status: 'active' }
      : { status: 'inactive' };
  } catch (err) {
    if (err instanceof LinqSendError && err.code === 'not_configured') {
      return { status: 'not_configured' };
    }
    if (err instanceof LinqSendError && (err.code === 'timeout' || err.code === 'network')) {
      return { status: 'unreachable' };
    }
    throw err;
  }
}

/**
 * Send a poll into a chat that already exists. At least two options. There is
 * no question field — the caller sends the question as its own text first.
 * Returns 202-class acceptance plus the option ids a later vote webhook uses.
 *
 * https://docs.linqapp.com/guides/messaging/polls/
 */
export async function sendLinqPoll(input: {
  chatId: string;
  options: readonly string[];
  idempotencyKey?: string;
  fetch?: typeof fetch;
}): Promise<{ messageId: string; options: LinqPollOptionRef[] }> {
  const texts = input.options.map((option) => option.trim()).filter((option) => option.length > 0);
  if (texts.length < 2) throw new LinqSendError('invalid_poll', 400, true);
  const result = await linqRequest({
    method: 'POST',
    path: `/chats/${encodeURIComponent(input.chatId)}/polls`,
    body: {
      poll: {
        options: texts.map((text) => ({ text })),
        ...(input.idempotencyKey ? { idempotency_key: input.idempotencyKey } : {}),
      },
    },
    fetch: input.fetch,
  });
  if (!result.ok) throw new LinqSendError(result.code, result.status, result.permanent);
  const envelope = readLinqPollEnvelope(result.payload);
  if (!envelope) throw new LinqSendError('missing_message_id', result.status, false);
  return envelope;
}

/** Screen effects. iMessage only; Linq ignores them on SMS and RCS. */
export const LINQ_SCREEN_EFFECTS = [
  'confetti',
  'fireworks',
  'lasers',
  'sparkles',
  'celebration',
  'hearts',
  'love',
  'balloons',
  'happy_birthday',
  'echo',
  'spotlight',
] as const;

/** Bubble effects. `invisible` is invisible ink. */
export const LINQ_BUBBLE_EFFECTS = ['slam', 'loud', 'gentle', 'invisible'] as const;

export type LinqScreenEffect = (typeof LINQ_SCREEN_EFFECTS)[number];
export type LinqBubbleEffect = (typeof LINQ_BUBBLE_EFFECTS)[number];

/**
 * Send one text with an iMessage effect. Helper only — no product moment calls
 * this. Confetti and invisible ink stay off the kids-year path until Design
 * names a moment.
 *
 * https://docs.linqapp.com/guides/messaging/message-effects/
 */
export async function sendLinqEffect(input: {
  chatId: string;
  text: string;
  effect: { type: 'screen'; name: LinqScreenEffect } | { type: 'bubble'; name: LinqBubbleEffect };
  fetch?: typeof fetch;
}): Promise<{ providerMessageId: string }> {
  if (!input.text.trim()) throw new LinqSendError('invalid_parts', 400, true);
  const result = await linqRequest({
    method: 'POST',
    path: `/chats/${encodeURIComponent(input.chatId)}/messages`,
    body: {
      message: {
        parts: [{ type: 'text', value: input.text }],
        effect: { type: input.effect.type, name: input.effect.name },
      },
    },
    fetch: input.fetch,
  });
  if (!result.ok) throw new LinqSendError(result.code, result.status, result.permanent);
  const providerMessageId = readLinqMessageId(result.payload);
  if (!providerMessageId) throw new LinqSendError('missing_message_id', result.status, false);
  return { providerMessageId };
}

/**
 * The intake-shaped transport for one iMessage turn, bound to the chat the
 * parent just texted. `mediaUrls` still throws: that argument is the welcome
 * vCard, which this leg does not know how to render, and dropping it would tell
 * the parent a card arrived. A public image URL goes through `sendLinqParts`.
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
