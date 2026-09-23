import type { ChannelTransport } from '~/lib/channel/intake/transport';
import { linqApiKey } from './config';

/**
 * VIL-335 — the outbound Linq leg. Raw `fetch`, no SDK, matching the Twilio
 * transport. One call: POST /api/partner/v3/chats/{chatId}/messages with the
 * body the partner reference documents (`message.parts`).
 *
 * https://docs.linqapp.com/api/resources/chats/subresources/messages/methods/send/
 *
 * Privacy (rule #1): the body and the chat id are arguments, never log lines.
 * A refusal carries Linq's numeric code and the HTTP status only — the error
 * `message` field can echo the text we sent.
 */

const LINQ_API_BASE = 'https://api.linqapp.com/api/partner/v3';

/** Inside Linq's 10s webhook budget when a keyword ack sends inline, and short
 * enough that a hung partner fails the turn instead of holding the instance. */
const SEND_TIMEOUT_MS = 8_000;

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

export async function sendLinqChatMessage(input: {
  chatId: string;
  text: string;
  fetch?: typeof fetch;
}): Promise<{ providerMessageId: string }> {
  const apiKey = linqApiKey();
  if (!apiKey) throw new LinqSendError('not_configured', 0, true);

  const doFetch = input.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let response: Response;
  try {
    response = await doFetch(
      `${LINQ_API_BASE}/chats/${encodeURIComponent(input.chatId)}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: { parts: [{ type: 'text', value: input.text }] },
        }),
        signal: controller.signal,
      },
    );
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new LinqSendError(aborted ? 'timeout' : 'network', 0, false);
  } finally {
    clearTimeout(timer);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = linqErrorCode(payload) ?? `http_${response.status}`;
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 429;
    throw new LinqSendError(code, response.status, permanent);
  }
  const providerMessageId = readLinqMessageId(payload);
  if (!providerMessageId) throw new LinqSendError('missing_message_id', response.status, false);
  return { providerMessageId };
}

/**
 * The intake-shaped transport for one iMessage turn, bound to the chat the
 * parent just texted. Media throws (the OutboundMessage contract): a vCard is
 * not an iMessage part this leg knows how to send, and dropping it would tell
 * the parent a card arrived.
 */
export function createLinqTextTransport(deps: {
  chatId: string | null;
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
        fetch: deps.fetch,
      });
      return { providerMessageId: sent.providerMessageId, transport: 'imessage' };
    },
  };
}
