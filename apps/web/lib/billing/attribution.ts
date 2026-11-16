import {
  type Attribution,
  ATTRIBUTION_KEYS,
  attributionIsEmpty,
  mergeFirstTouch,
  parseAttribution,
  serializeAttribution,
} from '@hale/types';

export const ATTRIBUTION_COOKIE = 'hale_attr';

/** Read first-touch attribution from a Cookie header, a query string, and/or a JSON body. */
export function attributionFromRequest(input: {
  cookieHeader?: string | null;
  search?: string | URLSearchParams | null;
  body?: Record<string, unknown> | null;
}): Attribution {
  const fromCookie = parseAttribution(cookieValue(input.cookieHeader, ATTRIBUTION_COOKIE));
  const fromSearch = parseAttribution(input.search);
  const fromBody = parseAttribution(input.body);
  return mergeFirstTouch(mergeFirstTouch(fromCookie, fromSearch), fromBody);
}

function cookieValue(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/** Stripe metadata keys for the session and the subscription (string values only). */
export function attributionToStripeMetadata(attribution: Attribution): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = attribution[key];
    if (value) out[key] = value;
  }
  return out;
}

export function attributionFromStripeMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Attribution {
  return parseAttribution(metadata ?? undefined);
}

export { attributionIsEmpty, parseAttribution, serializeAttribution };
