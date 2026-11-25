/**
 * First-touch acquisition params that survive landing → signup → checkout.
 *
 * These are advertising click and campaign identifiers plus Hale's own card code,
 * not parent or child data. Values are truncated so they fit Stripe metadata (500
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
  'source_code',
] as const;

export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];

export type Attribution = Partial<Record<AttributionKey, string>>;

const MAX_VALUE_LENGTH = 200;
const UNSAFE_VALUE = /@|:\/\/|[<>"]/;
/** The site's card-code grammar (apps/site/lib/text-entry.ts SOURCE_CODE_PATTERN). */
const SOURCE_CODE_VALUE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SOURCE_CODE_MAX_LENGTH = 48;

function cleanValue(key: AttributionKey, raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (key === 'source_code') {
    return trimmed.length <= SOURCE_CODE_MAX_LENGTH && SOURCE_CODE_VALUE.test(trimmed)
      ? trimmed
      : undefined;
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
