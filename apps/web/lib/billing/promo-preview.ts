import { timingSafeEqual } from 'node:crypto';
import { parseAllowlist } from '@hale/flags';

/**
 * Prod proofs while HOLIDAY_PROMO_ENABLED / PROMO_NEW_VISITOR_CHECKOUT_ENABLED
 * stay off. Default empty: nobody is listed, and an empty token never matches.
 * PAYMENT_ENV_ONLY — nothing in PostHog may populate these.
 */

export const PROMO_PREVIEW_FAMILY_IDS_ENV = 'PROMO_PREVIEW_FAMILY_IDS';
export const PROMO_PREVIEW_TOKEN_ENV = 'PROMO_PREVIEW_TOKEN';
/** Query key for `/founding?preview=<PROMO_PREVIEW_TOKEN>`. */
export const PROMO_PREVIEW_QUERY = 'preview';

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

export function stripePaymentLinkUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const url = env.STRIPE_PAYMENT_LINK_URL?.trim();
  return url ? url : null;
}
