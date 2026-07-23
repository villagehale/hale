import type { GoogleFetch } from '~/lib/integrations/sync';

/**
 * On-demand Gmail body fetch — the ONLY place this pipeline reads a full email
 * body. Built against E1's `GoogleFetch` seam (apps/web/lib/integrations/sync.ts)
 * so it shares the same mockable shape as the read-only connector sync; this
 * function does not touch a token store or cursor, it just re-fetches one
 * message by id with a caller-supplied access token.
 *
 * Retention (rule #1 / E1 policy): the returned body is TRANSIENT — held only in
 * the caller's stack frame for the extraction call. `BODY_RETENTION` names that
 * policy for grep-ability: there is no persistence, so no TTL to expire. Nothing
 * in this module writes the body anywhere; `SentinelClassification` (types.ts)
 * has no body field, so a body can't leak downstream by accident.
 */
export const BODY_RETENTION = 'transient-per-extraction-call' as const;

interface GmailMessagePart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailMessagePart[];
}

interface GmailMessageFullResponse {
  payload?: GmailMessagePart;
}

function decodeBase64Url(data: string): string {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

/** Depth-first search for the first part matching `mimeType`. Gmail nests plain
 * and html alternatives under `multipart/alternative`, so a plain part can be
 * several levels deep. */
function findPart(part: GmailMessagePart | undefined, mimeType: string): GmailMessagePart | null {
  if (!part) return null;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return null;
}

/** Crude tag strip for the html-only fallback — good enough for an LLM read, not
 * a rendering surface. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch one Gmail message's plain-text body by id. Prefers `text/plain`; falls
 * back to a tag-stripped `text/html`; a message with neither part (and no
 * top-level body — rare, but a non-multipart message stores its body directly on
 * `payload.body`) returns an empty string rather than throwing, since a body-less
 * fetch is a legitimate (if unusual) email, not a caller error.
 */
export async function fetchGmailMessageBody(
  messageId: string,
  accessToken: string,
  googleFetch: GoogleFetch,
): Promise<string> {
  const res = await googleFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    accessToken,
  );
  if (!res.ok) {
    throw new Error(`gmail messages.get ${res.status}`);
  }
  const data = (await res.json()) as GmailMessageFullResponse;
  const payload = data.payload;

  const plain = findPart(payload, 'text/plain');
  if (plain?.body?.data) return decodeBase64Url(plain.body.data);

  const html = findPart(payload, 'text/html');
  if (html?.body?.data) return stripHtml(decodeBase64Url(html.body.data));

  // Non-multipart message: the body rides directly on payload.body.
  if (payload?.body?.data) return decodeBase64Url(payload.body.data);

  return '';
}
