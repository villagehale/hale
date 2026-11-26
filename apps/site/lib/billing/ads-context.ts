/**
 * Click context for Meta CAPI on a /pricing Checkout Session.
 *
 * Same session-metadata keys as apps/web/lib/billing/ads-context.ts. fbp and fbc
 * stay off Attribution so they are not copied into PostHog. Subscription
 * metadata does not get them.
 */

export interface AdsCheckoutContext {
  readonly fbp?: string;
  readonly fbc?: string;
  readonly clientIp?: string;
  readonly clientUserAgent?: string;
}

const MAX_COOKIE = 200;
const MAX_UA = 200;
const MAX_IP = 45;

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

function clip(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

export function fbcFromFbclid(
  fbclid: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string {
  return `fb.1.${nowSeconds}.${fbclid.trim()}`;
}

/** First hop of x-forwarded-for / x-vercel-forwarded-for, else x-real-ip. */
export function clientIpFromHeaders(headers: {
  get(name: string): string | null;
}): string | undefined {
  const forwarded = headers.get('x-vercel-forwarded-for') ?? headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return clip(first ?? headers.get('x-real-ip') ?? undefined, MAX_IP);
}

export function adsContextFromRequest(input: {
  cookieHeader?: string | null;
  headers?: { get(name: string): string | null };
  fbclid?: string | null;
  nowSeconds?: number;
}): AdsCheckoutContext {
  const fbp = clip(cookieValue(input.cookieHeader, '_fbp'), MAX_COOKIE);
  const fbcCookie = clip(cookieValue(input.cookieHeader, '_fbc'), MAX_COOKIE);
  const fbclid = input.fbclid?.trim();
  const fbc = fbcCookie ?? (fbclid ? fbcFromFbclid(fbclid, input.nowSeconds) : undefined);
  const clientIp = input.headers ? clientIpFromHeaders(input.headers) : undefined;
  const clientUserAgent = input.headers
    ? clip(input.headers.get('user-agent') ?? undefined, MAX_UA)
    : undefined;
  return {
    ...(fbp ? { fbp } : {}),
    ...(fbc ? { fbc } : {}),
    ...(clientIp ? { clientIp } : {}),
    ...(clientUserAgent ? { clientUserAgent } : {}),
  };
}
