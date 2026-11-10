import { type GmailDraftFetch, encodeDraftRaw, headerValue } from './gmail-drafts.js';

/**
 * Sends one approved email from the parent's OWN Gmail account (users.messages.send).
 *
 * The only send path for an approved `send_email`: Hale has no mail provider of its
 * own, so the message leaves the parent's mailbox, from the parent's address, and
 * lands in their Sent folder. The `gmail.compose` grant the connector already asks
 * for covers `messages.send`; no `gmail.send` scope is requested.
 */

const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export interface GmailSendMessage {
  to: string;
  cc?: readonly string[];
  subject: string;
  body: string;
}

export class GmailSendApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`gmail send failed: ${status}`);
    this.name = 'GmailSendApiError';
    this.status = status;
  }
}

export function buildSendMime(message: GmailSendMessage): string {
  const lines = [`To: ${headerValue(message.to)}`];
  const cc = (message.cc ?? []).map(headerValue).filter((address) => address.length > 0);
  if (cc.length > 0) lines.push(`Cc: ${cc.join(', ')}`);
  lines.push(
    `Subject: ${headerValue(message.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  );
  const body = message.body.replace(/\r?\n/g, '\r\n');
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

export async function sendGmailMessage(
  accessToken: string,
  message: GmailSendMessage,
  fetchImpl: GmailDraftFetch = fetch,
): Promise<{ messageId: string }> {
  const res = await fetchImpl(SEND_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw: encodeDraftRaw(buildSendMime(message)) }),
  });
  if (res.status !== 200) throw new GmailSendApiError(res.status);
  const text = await res.text();
  let id: unknown = null;
  try {
    id = (JSON.parse(text) as { id?: unknown }).id;
  } catch {
    id = null;
  }
  if (typeof id !== 'string' || !id) throw new GmailSendApiError(res.status);
  return { messageId: id };
}
