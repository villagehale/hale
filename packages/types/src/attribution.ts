/**
 * First-touch acquisition params that survive landing → signup → checkout.
 *
 * These are advertising click and campaign identifiers plus Hale's own card code,
 * not parent or child data. `msclkid` is the Microsoft Ads click id and rides with
 * `gclid` and `fbclid`. Values are truncated so they fit Stripe metadata (500
 * chars). A value that carries an email's `@`, a URL's `://`, markup or a double quote
 * is dropped whole rather than carried, because these values reach Stripe and
 * analytics. Anything else a campaign name holds (accents, `'`, CJK, `|`, `/`, `:`)
 * passes.
 *
 * `source_code` is Hale's card code. The site reads it from its own `s` / `src` tag
 * with its own validator, never from a landing URL under this name.
 */

export const ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
  'msclkid',
  'source_code',
] as const;

export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];

export type Attribution = Partial<Record<AttributionKey, string>>;

const MAX_VALUE_LENGTH = 200;
const UNSAFE_VALUE = /@|:\/\/|[<>"]/;
/** The site's card-code grammar (apps/site/lib/text-entry.ts SOURCE_CODE_PATTERN). */
const SOURCE_CODE_VALUE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_CODE_MAX_LENGTH = 48;
/**
 * A co-parent join tag (`join-` + 32 hex, apps/web/lib/channel/join/code.ts). It
 * travels `?s=` so the text door can pre-fill the invite, and that grammar also
 * matches a card code. It is a capability: whoever redeems it is seated on the
 * family. It must not be stored as attribution or sent to Stripe or PostHog.
 */
const JOIN_CAPABILITY = /^join-[0-9a-f]{32}$/;

function cleanValue(key: AttributionKey, raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (key === 'source_code') {
    if (trimmed.length > SOURCE_CODE_MAX_LENGTH || !SOURCE_CODE_VALUE.test(trimmed)) {
      return undefined;
    }
    if (JOIN_CAPABILITY.test(trimmed)) return undefined;
    return trimmed;
  }
  const bounded = trimmed.slice(0, MAX_VALUE_LENGTH);
  return UNSAFE_VALUE.test(bounded) ? undefined : bounded;
}

/** Pull the known keys out of a query string, URLSearchParams, or a loose map. */
export function parseAttribution(
  source: string | URLSearchParams | Record<string, unknown> | null | undefined,
): Attribution {
  if (!source) return {};
  const params =
    typeof source === 'string'
      ? new URLSearchParams(source.startsWith('?') ? source.slice(1) : source)
      : source instanceof URLSearchParams
        ? source
        : null;
  const out: Attribution = {};
  if (params) {
    for (const key of ATTRIBUTION_KEYS) {
      const value = cleanValue(key, params.get(key));
      if (value) out[key] = value;
    }
    return out;
  }
  const record = source as Record<string, unknown>;
  for (const key of ATTRIBUTION_KEYS) {
    const value = cleanValue(key, record[key]);
    if (value) out[key] = value;
  }
  return out;
}

/** First touch wins: keys already set are kept; incoming fills only the gaps. */
export function mergeFirstTouch(existing: Attribution, incoming: Attribution): Attribution {
  const out: Attribution = { ...existing };
  for (const key of ATTRIBUTION_KEYS) {
    if (!out[key] && incoming[key]) out[key] = incoming[key];
  }
  return out;
}

export function attributionIsEmpty(attribution: Attribution): boolean {
  return ATTRIBUTION_KEYS.every((key) => !attribution[key]);
}

/** Cookie / Stripe-metadata serialization — query-string form, no leading `?`. */
export function serializeAttribution(attribution: Attribution): string {
  const params = new URLSearchParams();
  for (const key of ATTRIBUTION_KEYS) {
    const value = attribution[key];
    if (value) params.set(key, value);
  }
  return params.toString();
}

/**
 * Stripe session metadata key for a PostHog distinct id the visitor already
 * consented to. Not an attribution key: it must not be spread into event properties.
 */
export const ANALYTICS_DISTINCT_ID_KEY = 'ph_distinct_id';

const ANALYTICS_DISTINCT_ID = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * A browser distinct id from a consented PostHog client. Emails, checkout
 * session ids, and short tokens are dropped. Null when the visitor has not
 * accepted analytics, because that client is never loaded.
 */
export function analyticsDistinctId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!ANALYTICS_DISTINCT_ID.test(trimmed)) return null;
  if (trimmed.startsWith('cs_') || trimmed.startsWith('cs:')) return null;
  return trimmed;
}

/**
 * Person key for a Checkout Session that has no family yet. Null when the id
 * is not a session id. The key is `cs:` plus the SHA-256 of the session id.
 * The raw id opens the success-page code send, so it does not go to PostHog.
 */
export function checkoutPersonId(sessionId: string): string | null {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return null;
  return `cs:${sha256Hex(sessionId)}`;
}

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Sync SHA-256. Session ids are short, and this file is also imported by the site client. */
function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bytes.length * 8, false);
  const k = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1)
      w[index] = view.getUint32(offset + index * 4, false);
    for (let index = 16; index < 64; index += 1) {
      const w15 = w[index - 15] ?? 0;
      const w2 = w[index - 2] ?? 0;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[index] = (((w[index - 16] ?? 0) + s0 + (w[index - 7] ?? 0) + s1) >>> 0) >>> 0;
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let index = 0; index < 64; index += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + (k[index] ?? 0) + (w[index] ?? 0)) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  return [h0, h1, h2, h3, h4, h5, h6, h7]
    .map((word) => word.toString(16).padStart(8, '0'))
    .join('');
}
