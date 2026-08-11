import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Request authentication for the inbound-email webhook — the email twin of
 * twilio/signature.ts, and the same gate for the same reason: anyone who can POST to a
 * public URL can claim to be the provider and claim to be any `From` address. Without
 * this an attacker could forge a parent's unsubscribe (a CASL event), forge a reply the
 * router will act on, or push arbitrary text into a family's ledger. It runs before the
 * payload is parsed, before any write, and before the content fetch it would otherwise
 * provoke.
 *
 * Resend signs webhooks with the Svix / Standard Webhooks scheme
 * (resend.com/docs/webhooks/verify-webhooks-requests):
 *
 *   base      = `${svix-id}.${svix-timestamp}.${raw body}`
 *   signature = base64(HMAC-SHA256(key, base)), sent as `v1,<digest>`
 *   key       = base64-decode(secret without its `whsec_` label)
 *
 * Three details are load-bearing and each is pinned by a test:
 *
 *   THE RAW BODY. The digest covers the bytes as sent. Parsing the JSON and
 *   re-stringifying it changes key order and whitespace, so the caller must hand us
 *   `await req.text()` and parse only AFTER this returns true.
 *
 *   THE LIST. The header carries a SPACE-SEPARATED list of versioned signatures so a
 *   secret can be rotated without downtime — during the overlap both the old and the
 *   new signature ride along. A verifier that reads only the first entry rejects half
 *   the traffic mid-rotation, so every `v1` entry is tried.
 *
 *   THE TIMESTAMP. Unlike Twilio's scheme this one has a nonce and a clock, so replay
 *   IS defensible here — and the timestamp is checked because it is inside the signed
 *   base string, which is what stops an attacker editing the header to a fresh time.
 *   It is a bound on replay, not a substitute for idempotency: a genuine retry inside
 *   the window is still deduped downstream on the provider's message id.
 *
 * We implement the scheme rather than construct an SDK client for it, exactly as the
 * Twilio leg does: verification must be a pure function of (secret, headers, body) so
 * it is testable without a provider, and so a forged request cannot cause a client to
 * be built.
 */

/** How far the signed timestamp may sit from our clock, either way. Svix's own default:
 * wide enough for ordinary skew and provider retries, narrow enough that a captured
 * request stops being useful in minutes. */
const TOLERANCE_SECONDS = 5 * 60;

const SECRET_LABEL = /^whsec_/;

/** The exact string the provider signed. */
export function resendSignatureBase(id: string, timestamp: string, payload: string): string {
  return `${id}.${timestamp}.${payload}`;
}

/** The key bytes inside a `whsec_`-labelled secret. The label is not key material —
 * hashing with it included fails every genuine request. */
function secretKey(secret: string): Buffer | null {
  const encoded = secret.replace(SECRET_LABEL, '');
  if (!encoded) return null;
  const key = Buffer.from(encoded, 'base64');
  return key.length > 0 ? key : null;
}

/** Constant-time equality over two base64 digests. */
function digestMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Whether the signed timestamp is close enough to now to not be a stale replay. */
function withinTolerance(timestamp: string, now: Date): boolean {
  const signedAt = Number(timestamp);
  if (!Number.isFinite(signedAt)) return false;
  const skewSeconds = Math.abs(now.getTime() / 1000 - signedAt);
  return skewSeconds <= TOLERANCE_SECONDS;
}

/**
 * Whether these headers authenticate this exact body. False — never a throw — for every
 * malformed input, so a probe learns nothing from an error body, and constant-time on
 * the comparison so it learns nothing from timing either.
 */
export function isValidResendSignature(input: {
  secret: string;
  id: string | null;
  timestamp: string | null;
  signature: string | null;
  payload: string;
  now: Date;
}): boolean {
  const { secret, id, timestamp, signature, payload, now } = input;
  if (!id || !timestamp || !signature) return false;

  const key = secretKey(secret);
  if (!key) return false;
  if (!withinTolerance(timestamp, now)) return false;

  const expected = createHmac('sha256', key)
    .update(resendSignatureBase(id, timestamp, payload), 'utf8')
    .digest('base64');

  // Every `v1` entry is tried so a rotation overlap verifies; an unknown version is
  // skipped rather than trusted, because we cannot check a scheme we do not implement.
  return signature
    .split(' ')
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => entry.slice('v1,'.length))
    .some((provided) => provided.length > 0 && digestMatches(expected, provided));
}
