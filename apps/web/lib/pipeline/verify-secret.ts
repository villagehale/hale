import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Inbound webhook authentication for the normalized event pipeline.
 *
 * The inbound PROVIDER (Postmark inbound parse, a Gmail Pub/Sub forwarder, etc. —
 * the user's wiring step) POSTs a normalized payload to /api/events/ingest. We
 * authenticate it with an HMAC-SHA256 of the RAW body keyed by
 * INBOUND_WEBHOOK_SECRET, sent in the `x-hale-signature` header. This is the only
 * thing that may inject an event into the pipeline (which spends Anthropic tokens
 * and writes a family's data), so it FAILS CLOSED:
 *
 *   - INBOUND_WEBHOOK_SECRET unset      → 401 (the route is unreachable, not open)
 *   - signature header missing/malformed→ 401
 *   - signature does not match the body → 401
 *
 * The compare is constant-time over the raw HMAC bytes so a forged signature
 * cannot be tuned byte-by-byte via a timing oracle.
 */

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'missing_signature' | 'invalid_signature' };

export const INBOUND_SIGNATURE_HEADER = 'x-hale-signature';

/** Compute the expected hex signature for a body — exported so a provider's
 * forwarder (or a test) signs identically. */
export function signInboundBody(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyInboundSignature(signature: string | null, rawBody: string): VerifyResult {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret) {
    return { ok: false, reason: 'not_configured' };
  }
  if (!signature) {
    return { ok: false, reason: 'missing_signature' };
  }

  const expected = signInboundBody(secret, rawBody);
  const expectedBuf = Buffer.from(expected, 'hex');
  let providedBuf: Buffer;
  try {
    providedBuf = Buffer.from(signature, 'hex');
  } catch {
    return { ok: false, reason: 'invalid_signature' };
  }
  if (providedBuf.length !== expectedBuf.length || !timingSafeEqual(providedBuf, expectedBuf)) {
    return { ok: false, reason: 'invalid_signature' };
  }
  return { ok: true };
}
