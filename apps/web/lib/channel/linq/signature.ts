import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * VIL-335 — Standard Webhooks verification for Linq.
 *
 * https://docs.linqapp.com/guides/webhooks/
 *
 * Signed content is `{webhook-id}.{webhook-timestamp}.{rawBody}`. The key is the
 * `whsec_` secret with the prefix stripped and the remainder base64-decoded. The
 * `webhook-signature` header is one or more space-separated `v1,{base64}` tokens.
 * A timestamp more than five minutes from now is a replay and is rejected.
 *
 * False, never a throw, for every malformed input. A probe learns nothing from an
 * error body, and a missing header is the same answer as a bad signature.
 */

/** Linq's documented replay window. */
export const LINQ_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

/** The payload version this door accepts. Pinned on the subscription URL. */
export const LINQ_WEBHOOK_VERSION = '2026-02-03';

export function verifyLinqWebhookSignature(input: {
  secret: string;
  rawBody: string;
  webhookId: string | null;
  timestamp: string | null;
  signature: string | null;
  now?: Date;
}): boolean {
  const { secret, rawBody, webhookId, timestamp, signature } = input;
  if (!webhookId || !timestamp || !signature) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSec - ts) > LINQ_SIGNATURE_TOLERANCE_SECONDS) return false;

  const secretStr = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
  if (!secretStr) return false;
  const key = Buffer.from(secretStr, 'base64');
  if (key.length === 0) return false;

  const expected = createHmac('sha256', key)
    .update(`${webhookId}.${timestamp}.${rawBody}`)
    .digest();

  for (const part of signature.split(' ')) {
    if (!part.startsWith('v1,')) continue;
    const provided = Buffer.from(part.slice(3), 'base64');
    if (provided.length !== expected.length) continue;
    if (timingSafeEqual(expected, provided)) return true;
  }
  return false;
}
