import { createHmac, timingSafeEqual } from 'node:crypto';
import { parseAllowlist } from '@hale/flags';

/**
 * Prod proofs while HOLIDAY_PROMO_ENABLED / PROMO_NEW_VISITOR_CHECKOUT_ENABLED
 * stay off. Default empty: nobody is listed, and an empty token never matches.
 * PAYMENT_ENV_ONLY — nothing in PostHog may populate these.
 */

export const PROMO_PREVIEW_FAMILY_IDS_ENV = 'PROMO_PREVIEW_FAMILY_IDS';
export const PROMO_PREVIEW_TOKEN_ENV = 'PROMO_PREVIEW_TOKEN';
/** Query key for `/join?preview=<PROMO_PREVIEW_TOKEN>`. */
export const PROMO_PREVIEW_QUERY = 'preview';
/**
 * HttpOnly cookie so a Stripe cancel URL without `?preview=` still opens
 * `/join`. Signed with AUTH_SECRET plus the expected token — rotating the
 * token invalidates outstanding cookies. Never put the raw token in the cookie
 * or on a Stripe success/cancel URL.
 */
export const PROMO_PREVIEW_COOKIE = 'hale_promo_preview';
export const PROMO_PREVIEW_COOKIE_TTL_SECONDS = 2 * 60 * 60;

export function promoPreviewFamilyIds(
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  return parseAllowlist(env, PROMO_PREVIEW_FAMILY_IDS_ENV);
}

export function isPromoPreviewFamily(
  familyId: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!familyId) return false;
  return promoPreviewFamilyIds(env).has(familyId);
}

function tokenEquals(expected: string, provided: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function promoPreviewTokenMatches(
  candidate: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const expected = env[PROMO_PREVIEW_TOKEN_ENV]?.trim();
  if (!expected) return false;
  const provided = candidate?.trim();
  if (!provided) return false;
  return tokenEquals(expected, provided);
}

export function promoPreviewTokenFromSearch(
  search: URLSearchParams | null | undefined,
): string | null {
  const value = search?.get(PROMO_PREVIEW_QUERY)?.trim();
  return value ? value : null;
}

function previewCookieSecret(env: Record<string, string | undefined>): string | null {
  const auth = env.AUTH_SECRET?.trim();
  const token = env[PROMO_PREVIEW_TOKEN_ENV]?.trim();
  if (!auth || !token) return null;
  return `${auth}:${token}`;
}

function signPreviewMac(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function signPromoPreviewCookie(
  env: Record<string, string | undefined> = process.env,
  opts: { ttlSeconds?: number; now?: number } = {},
): string | null {
  const secret = previewCookieSecret(env);
  if (!secret) return null;
  const exp =
    (opts.now ?? Date.now()) + (opts.ttlSeconds ?? PROMO_PREVIEW_COOKIE_TTL_SECONDS) * 1000;
  const body = Buffer.from(JSON.stringify({ exp })).toString('base64url');
  return `${body}.${signPreviewMac(body, secret)}`;
}

export function readPromoPreviewCookie(
  token: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  opts: { now?: number } = {},
): boolean {
  const secret = previewCookieSecret(env);
  if (!secret || !token) return false;
  const [body, mac] = token.split('.');
  if (!body || !mac) return false;
  const expected = Buffer.from(signPreviewMac(body, secret));
  const provided = Buffer.from(mac);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return false;
  }
  let payload: { exp?: unknown };
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { exp?: unknown };
  } catch {
    return false;
  }
  return typeof payload.exp === 'number' && (opts.now ?? Date.now()) <= payload.exp;
}

export function promoPreviewCookieFromHeader(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== PROMO_PREVIEW_COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

export function stripePaymentLinkUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const url = env.STRIPE_PAYMENT_LINK_URL?.trim();
  return url ? url : null;
}
