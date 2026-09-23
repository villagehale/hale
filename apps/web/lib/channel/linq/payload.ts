import { LINQ_WEBHOOK_VERSION } from './signature';

/**
 * VIL-335 — the `2026-02-03` webhook envelope, and only that version.
 *
 * https://docs.linqapp.com/guides/webhooks/events/
 *
 * `message.received` puts the message fields on `data` (not nested under
 * `data.message`), the sender on `data.sender_handle.handle`, and the chat on
 * `data.chat.id`. Group chats are recognised and refused here: this door is 1:1.
 *
 * `message.delivered`, `message.read`, and `message.failed` are receipts for a
 * message we already sent. They are parsed, not routed.
 */

export type LinqIgnoreReason =
  | 'malformed'
  | 'unsupported_version'
  | 'not_message_received'
  | 'outbound'
  | 'group';

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
}

export type LinqParsedWebhook =
  | { kind: 'message'; message: LinqInboundText }
  | { kind: 'receipt'; receipt: LinqDeliveryReceipt }
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
  if (payload.event_type !== 'message.received') {
    return { kind: 'ignored', reason: 'not_message_received' };
  }
  if (!isRecord(payload.data)) return { kind: 'ignored', reason: 'malformed' };
  const data = payload.data;

  if (data.direction === 'outbound') return { kind: 'ignored', reason: 'outbound' };
  if (!isRecord(data.sender_handle)) return { kind: 'ignored', reason: 'malformed' };
  if (data.sender_handle.is_me === true) return { kind: 'ignored', reason: 'outbound' };

  if (!isRecord(data.chat)) return { kind: 'ignored', reason: 'malformed' };
  if (data.chat.is_group === true) return { kind: 'ignored', reason: 'group' };

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
    kind: 'message',
    message: {
      messageId,
      chatId,
      senderHandle,
      text: texts.join('\n'),
      mediaCount,
      receivedAt,
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
