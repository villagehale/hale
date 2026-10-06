/**
 * Gmail drafts only (VIL-93).
 *
 * Hale creates, updates, and deletes a draft in the parent's mailbox. It never
 * calls users.messages.send or users.drafts.send, and it never requests
 * gmail.send. The parent reviews and sends the draft in Gmail.
 */

const DRAFTS_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/drafts';

export interface GmailDraftMessage {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

export interface GoogleFetchResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}

export type GmailDraftFetch = (url: string, init: RequestInit) => Promise<GoogleFetchResponse>;

export class GmailDraftApiError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`gmail draft failed: ${status}`);
    this.name = 'GmailDraftApiError';
    this.status = status;
  }
}

/** Header values cannot carry a newline. A newline is how a body becomes a header. */
export function headerValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

export function buildDraftMime(message: GmailDraftMessage): string {
  const lines = [
    `To: ${headerValue(message.to)}`,
    `Subject: ${headerValue(message.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (message.inReplyTo) lines.push(`In-Reply-To: ${headerValue(message.inReplyTo)}`);
  if (message.references) lines.push(`References: ${headerValue(message.references)}`);
  const body = message.body.replace(/\r?\n/g, '\r\n');
  return `${lines.join('\r\n')}\r\n\r\n${body}`;
}

export function encodeDraftRaw(mime: string): string {
  return Buffer.from(mime, 'utf8').toString('base64url');
}

function draftBody(message: GmailDraftMessage): { message: { raw: string; threadId?: string } } {
  const raw = encodeDraftRaw(buildDraftMime(message));
  return {
    message: {
      raw,
      ...(message.threadId ? { threadId: message.threadId } : {}),
    },
  };
}

async function callGmail(
  fetchImpl: GmailDraftFetch,
  accessToken: string,
  url: string,
  method: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetchImpl(url, {
    method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      json = null;
    }
  }
  return { status: res.status, json };
}

function draftIdFrom(json: unknown): string {
  const id = (json as { id?: unknown } | null)?.id;
  if (typeof id !== 'string' || !id) throw new GmailDraftApiError(200);
  return id;
}

export async function createGmailDraft(
  accessToken: string,
  message: GmailDraftMessage,
  fetchImpl: GmailDraftFetch = fetch,
): Promise<{ draftId: string }> {
  const { status, json } = await callGmail(
    fetchImpl,
    accessToken,
    DRAFTS_URL,
    'POST',
    draftBody(message),
  );
  if (status !== 200 && status !== 201) throw new GmailDraftApiError(status);
  return { draftId: draftIdFrom(json) };
}

export async function updateGmailDraft(
  accessToken: string,
  draftId: string,
  message: GmailDraftMessage,
  fetchImpl: GmailDraftFetch = fetch,
): Promise<{ draftId: string }> {
  const url = `${DRAFTS_URL}/${encodeURIComponent(draftId)}`;
  const { status, json } = await callGmail(fetchImpl, accessToken, url, 'PUT', draftBody(message));
  if (status !== 200) throw new GmailDraftApiError(status);
  const id = (json as { id?: unknown } | null)?.id;
  return { draftId: typeof id === 'string' && id ? id : draftId };
}

export async function deleteGmailDraft(
  accessToken: string,
  draftId: string,
  fetchImpl: GmailDraftFetch = fetch,
): Promise<{ draftId: string; alreadyGone: boolean }> {
  const url = `${DRAFTS_URL}/${encodeURIComponent(draftId)}`;
  const { status } = await callGmail(fetchImpl, accessToken, url, 'DELETE');
  if (status === 404) return { draftId, alreadyGone: true };
  if (status !== 200 && status !== 204) throw new GmailDraftApiError(status);
  return { draftId, alreadyGone: false };
}
