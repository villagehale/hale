import { LINQ_WEBHOOK_VERSION } from './signature';

/**
 * VIL-335 — the `2026-02-03` webhook envelope, and only that version.
 *
 * https://docs.linqapp.com/guides/webhooks/events/
 *
 * `message.received` puts the message fields on `data` (not nested under
 * `data.message`), the sender on `data.sender_handle.handle`, and the chat on
 * `data.chat.id`. Group chats are recognised and refused here: this door is 1:1.
 */

export type LinqIgnoreReason =
  | 'malformed'
  | 'unsupported_version'
  | 'not_message_received'
  | 'outbound'
  | 'group';

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
  | { kind: 'ignored'; reason: LinqIgnoreReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
