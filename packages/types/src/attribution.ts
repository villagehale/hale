/**
 * First-touch acquisition params that survive landing → signup → checkout.
 *
 * These are advertising click and campaign identifiers, not parent or child
 * data. Values are truncated so they fit Stripe metadata (500 chars).
 */

export const ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
] as const;

export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];

export type Attribution = Partial<Record<AttributionKey, string>>;

const MAX_VALUE_LENGTH = 200;

function readParam(
  params: { get(name: string): string | null },
  key: AttributionKey,
): string | undefined {
  const raw = params.get(key)?.trim();
  if (!raw) return undefined;
  return raw.slice(0, MAX_VALUE_LENGTH);
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
      const value = readParam(params, key);
      if (value) out[key] = value;
    }
    return out;
  }
  const record = source as Record<string, unknown>;
  for (const key of ATTRIBUTION_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      out[key] = value.trim().slice(0, MAX_VALUE_LENGTH);
    }
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
