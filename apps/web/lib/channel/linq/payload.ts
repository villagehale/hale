import { LINQ_WEBHOOK_VERSION } from './signature';

/**
 * VIL-335 — the `2026-02-03` webhook envelope, and only that version.
 *
 * https://docs.linqapp.com/guides/webhooks/events/
 *
 * `message.received` puts the message fields on `data` (not nested under
 * `data.message`), the sender on `data.sender_handle.handle`, and the chat on
 * `data.chat.id`. A group chat is its own kind: the door accepts it only when
 * the sender already belongs to a family.
 *
 * `message.delivered`, `message.read`, and `message.failed` are receipts for a
 * message we already sent. Reactions, typing, and poll votes are signals: the
 * door acks them and does not crash on a type it has not met.
 */

export type LinqIgnoreReason =
  | 'malformed'
  | 'unsupported_version'
  | 'not_message_received'
  | 'outbound';

export type LinqSignalEvent =
  | 'reaction.added'
  | 'reaction.removed'
  | 'chat.typing_indicator.started'
  | 'chat.typing_indicator.stopped'
  | 'poll.vote.added'
  | 'poll.vote.removed'
  | 'participant.added'
  | 'participant.removed';

/** A webhook this door records and does not route as a parent text. Handles
 * and phone numbers are not copied onto the signal. */
export interface LinqSignal {
  event: LinqSignalEvent;
  chatId: string | null;
  messageId: string | null;
  reactionType: string | null;
  optionId: string | null;
  /** The voter, for a poll vote only. Never logged. Null on typing and reactions. */
  senderHandle: string | null;
  /** True when Linq says the event is ours. Our own tapback echo is not a parent. */
  isFromMe: boolean;
}

/** Delivery receipts the ledger already knows how to store. `read` is its own
 * event so a log line can pace on it; the ledger status it writes is still
 * `delivered`, which is the furthest the status enum goes (Twilio does the
 * same). `message.failed` uses `data.message_id` and `data.code`, not the
 * message-event envelope the other two share. */
export type LinqReceiptEvent = 'message.delivered' | 'message.read' | 'message.failed';

export interface LinqDeliveryReceipt {
  event: LinqReceiptEvent;
  messageId: string;
  /** What `applyTwilioStatus` already maps. `read` advances the row to delivered. */
  rawStatus: 'delivered' | 'read' | 'failed';
  errorCode: string | null;
}

export interface LinqInboundText {
  messageId: string;
  chatId: string;
  /** The sender handle as Linq sent it. Not yet validated as E.164. */
  senderHandle: string;
  text: string;
  /** Parts that are not text. The SMS door's media rule still applies. */
  mediaCount: number;
  receivedAt: Date;
  /** Other participants when the payload carried them. Empty means the webhook
   * did not list them — message.received does not — not that the chat is empty. */
  otherHandles: string[];
}

export type LinqParsedWebhook =
  | { kind: 'message'; message: LinqInboundText }
  | { kind: 'group'; message: LinqInboundText }
  | { kind: 'receipt'; receipt: LinqDeliveryReceipt }
  | { kind: 'signal'; signal: LinqSignal }
  | { kind: 'ignored'; reason: LinqIgnoreReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const RECEIPT_EVENTS: readonly LinqReceiptEvent[] = [
  'message.delivered',
  'message.read',
  'message.failed',
];

function isReceiptEvent(value: unknown): value is LinqReceiptEvent {
  return typeof value === 'string' && (RECEIPT_EVENTS as readonly string[]).includes(value);
}

const SIGNAL_EVENTS: readonly LinqSignalEvent[] = [
  'reaction.added',
  'reaction.removed',
  'chat.typing_indicator.started',
  'chat.typing_indicator.stopped',
  'poll.vote.added',
  'poll.vote.removed',
  'participant.added',
  'participant.removed',
];

function isSignalEvent(value: unknown): value is LinqSignalEvent {
  return typeof value === 'string' && (SIGNAL_EVENTS as readonly string[]).includes(value);
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Parse one authenticated body. Never throws: a shape we do not understand is a
 * named ignore, so a new event type Linq adds does not 500 the door.
 */
export function parseLinqWebhook(payload: unknown, receivedAtFallback: Date): LinqParsedWebhook {
  if (!isRecord(payload)) return { kind: 'ignored', reason: 'malformed' };
  if (payload.webhook_version !== LINQ_WEBHOOK_VERSION) {
    return { kind: 'ignored', reason: 'unsupported_version' };
  }
  if (isReceiptEvent(payload.event_type)) return parseReceipt(payload, payload.event_type);
  if (isSignalEvent(payload.event_type)) return parseSignal(payload, payload.event_type);
  if (payload.event_type !== 'message.received') {
    return { kind: 'ignored', reason: 'not_message_received' };
  }
  if (!isRecord(payload.data)) return { kind: 'ignored', reason: 'malformed' };
  const data = payload.data;

  if (data.direction === 'outbound') return { kind: 'ignored', reason: 'outbound' };
  if (!isRecord(data.sender_handle)) return { kind: 'ignored', reason: 'malformed' };
  if (data.sender_handle.is_me === true) return { kind: 'ignored', reason: 'outbound' };

  if (!isRecord(data.chat)) return { kind: 'ignored', reason: 'malformed' };
  const isGroup = data.chat.is_group === true;

  const chatId = typeof data.chat.id === 'string' ? data.chat.id : '';
  const messageId = typeof data.id === 'string' ? data.id : '';
  const senderHandle =
    typeof data.sender_handle.handle === 'string' ? data.sender_handle.handle : '';
  if (!chatId || !messageId || !senderHandle) {
    return { kind: 'ignored', reason: 'malformed' };
  }

  const parts = Array.isArray(data.parts) ? data.parts : [];
  const texts: string[] = [];
  let mediaCount = 0;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && typeof part.value === 'string' && part.value.trim()) {
      texts.push(part.value);
    } else if (part.type && part.type !== 'text') {
      mediaCount += 1;
    }
  }
  if (texts.length === 0 && mediaCount === 0) {
    return { kind: 'ignored', reason: 'malformed' };
  }

  const sentAt = typeof data.sent_at === 'string' ? new Date(data.sent_at) : receivedAtFallback;
  const receivedAt = Number.isNaN(sentAt.getTime()) ? receivedAtFallback : sentAt;

  return {
    kind: isGroup ? 'group' : 'message',
    message: {
      messageId,
      chatId,
      senderHandle,
      text: texts.join('\n'),
      mediaCount,
      receivedAt,
      otherHandles: otherHandles(data.chat),
    },
  };
}

function otherHandles(chat: Record<string, unknown>): string[] {
  if (!Array.isArray(chat.handles)) return [];
  const out: string[] = [];
  for (const handle of chat.handles) {
    if (!isRecord(handle) || handle.is_me === true) continue;
    if (typeof handle.handle === 'string' && handle.handle) out.push(handle.handle);
  }
  return out;
}

function parseSignal(payload: Record<string, unknown>, event: LinqSignalEvent): LinqParsedWebhook {
  if (!isRecord(payload.data)) return { kind: 'ignored', reason: 'malformed' };
  const data = payload.data;
  const chat = isRecord(data.chat) ? data.chat : null;
  const chatId = stringField(data.chat_id) || (chat && typeof chat.id === 'string' ? chat.id : '');
  const messageId = stringField(data.message_id) || stringField(data.id);
  const reactionType = stringField(data.reaction_type) || null;
  const optionId = stringField(data.option_id) || null;
  const fromHandle = isRecord(data.from_handle) ? data.from_handle : null;
  const sender = isRecord(data.sender_handle) ? data.sender_handle : null;
  const from = isRecord(data.from) ? data.from : null;
  const isFromMe = data.is_from_me === true || fromHandle?.is_me === true || sender?.is_me === true;
  const senderHandle =
    stringField(sender?.handle) ||
    stringField(from?.handle) ||
    (typeof data.from === 'string' ? data.from : '');
  return {
    kind: 'signal',
    signal: {
      event,
      chatId: chatId || null,
      messageId: messageId || null,
      reactionType,
      optionId,
      senderHandle: senderHandle || null,
      isFromMe,
    },
  };
}

function parseReceipt(
  payload: Record<string, unknown>,
  event: LinqReceiptEvent,
): LinqParsedWebhook {
  if (!isRecord(payload.data)) return { kind: 'ignored', reason: 'malformed' };
  const data = payload.data;
  // message.failed is a smaller envelope: message_id + code, not data.id.
  const messageId =
    event === 'message.failed'
      ? stringField(data.message_id) || stringField(data.id)
      : stringField(data.id);
  if (!messageId) return { kind: 'ignored', reason: 'malformed' };
  const code = data.code;
  const errorCode =
    event === 'message.failed' && (typeof code === 'number' || typeof code === 'string')
      ? String(code)
      : null;
  const rawStatus =
    event === 'message.failed' ? 'failed' : event === 'message.read' ? 'read' : 'delivered';
  return { kind: 'receipt', receipt: { event, messageId, rawStatus, errorCode } };
}
