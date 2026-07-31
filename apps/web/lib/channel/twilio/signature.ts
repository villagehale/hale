import { createHmac, timingSafeEqual } from 'node:crypto';
import { appBaseUrl } from '~/lib/cron/email-compliance';

/**
 * VIL-214 · A3 — request authentication for the two Twilio webhooks.
 *
 * Twilio's documented scheme (twilio.com/docs/usage/security): take the exact request
 * URL, append every POST parameter as `name` immediately followed by `value` in
 * case-sensitive key order with NO delimiters, HMAC-SHA1 it with the account's PRIMARY
 * auth token, base64 the digest. An API key secret cannot do this — the auth token is
 * the only key Twilio signs with, which is why A3 needs it alongside the REST key pair.
 *
 * This is the whole gate. Anyone who can POST to a public URL can claim to be Twilio
 * and claim to be any `From` number; without the signature an attacker could forge a
 * parent's STOP (a CASL event), forge their reply (which C1 will act on), or push
 * arbitrary text into a family's ledger. So it runs before parsing intent, before any
 * write, and before any model or provider spend.
 */

export type TwilioParams = Readonly<Record<string, string>>;

/** The exact string Twilio signed: URL + `keyvalue` for each param, sorted by key. */
export function twilioSignatureBase(url: string, params: TwilioParams): string {
  let base = url;
  // Default string sort IS the case-sensitive Unix order Twilio specifies (UTF-16
  // code-unit order), so uppercase keys sort before lowercase ones.
  for (const key of Object.keys(params).sort()) {
    base += key + params[key];
  }
  return base;
}

export function computeTwilioSignature(
  authToken: string,
  url: string,
  params: TwilioParams,
): string {
  return createHmac('sha1', authToken).update(twilioSignatureBase(url, params), 'utf8').digest(
    'base64',
  );
}

/**
 * Whether `signature` is Twilio's over this exact (url, params) pair. Constant-time on
 * the comparison, and false — never a throw — for every malformed input, so a probe
 * learns nothing from timing or from an error body.
 *
 * NOTE what this canNOT do: a byte-identical replay of a genuine Twilio request carries
 * a genuine signature, and no signature scheme without a nonce or timestamp can tell it
 * from the original. Twilio's has neither. Replay is therefore an IDEMPOTENCY problem,
 * handled downstream by the provider message id (see inbound.ts), not a signature one.
 */
export function isValidTwilioSignature(input: {
  authToken: string;
  url: string;
  params: TwilioParams;
  signature: string | null;
}): boolean {
  if (!input.signature) return false;
  const expected = Buffer.from(computeTwilioSignature(input.authToken, input.url, input.params));
  const provided = Buffer.from(input.signature);
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/**
 * The URL to verify against: our own configured origin plus the request's path and
 * query — deliberately NOT the `Host` / `X-Forwarded-Host` headers.
 *
 * Those headers are attacker-controlled. Rebuilding the signed URL from them lets a
 * forwarded request be validated against whatever host the attacker claims, which is a
 * known bypass in naive implementations. APP_URL is the origin we registered in the
 * Twilio console, so it is the only value that can legitimately have been signed — a
 * mismatch between the two is a misconfiguration we WANT to fail loudly (403) rather
 * than paper over.
 */
export function twilioWebhookUrl(req: Request): string {
  const requested = new URL(req.url);
  return `${appBaseUrl()}${requested.pathname}${requested.search}`;
}

/** Twilio posts `application/x-www-form-urlencoded`; a body we can't parse that way
 * yields params that cannot match the signature, so it fails closed on its own. */
export function parseTwilioParams(rawBody: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(rawBody));
}
