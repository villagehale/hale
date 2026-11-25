import { holidayPromoEnabled, promoNewVisitorCheckoutEnabled } from './flags.js';
import { foundingWindowOpen } from './prices.js';
import {
  isPromoPreviewFamily,
  promoPreviewCookieFromHeader,
  promoPreviewTokenFromSearch,
  promoPreviewTokenMatches,
  readPromoPreviewCookie,
} from './promo-preview.js';

/**
 * Signed-in founding checkout (Plan, /settings/founding, POST /api/billing/checkout).
 * Live flag lights it for every family in the window. Otherwise only listed
 * preview families. After the cutoff, nobody.
 */
export function familyMayUseFoundingCheckout(
  familyId: string | null | undefined,
  now: Date,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!foundingWindowOpen(now, env)) return false;
  if (holidayPromoEnabled(env)) return true;
  return isPromoPreviewFamily(familyId, env);
}

export type UnpaidPlanSurface = 'founding' | 'list' | 'free';

/**
 * What an unpaid family sees on Plan. During the window (live flag or a listed
 * preview family): Free + founding annual only — never monthly, regular annual,
 * or a disabled list option. After the cutoff, with the live flag on, list
 * monthly and annual return. Otherwise the free-only founding card.
 */
export function unpaidPlanSurface(
  familyId: string | null | undefined,
  now: Date,
  env: Record<string, string | undefined> = process.env,
): UnpaidPlanSurface {
  if (familyMayUseFoundingCheckout(familyId, now, env)) return 'founding';
  if (holidayPromoEnabled(env) && !foundingWindowOpen(now, env)) return 'list';
  return 'free';
}

/**
 * Ads new-visitor /join page and its join APIs. Live when both payment flags are on
 * in the window. Otherwise only with a matching PROMO_PREVIEW_TOKEN.
 */
export function newVisitorFoundingAllowed(
  now: Date,
  token: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  previewCookie: string | null | undefined = null,
): boolean {
  if (!foundingWindowOpen(now, env)) return false;
  if (promoNewVisitorCheckoutEnabled(env) && holidayPromoEnabled(env)) return true;
  if (promoPreviewTokenMatches(token, env)) return true;
  return readPromoPreviewCookie(previewCookie, env);
}

/** Query token or the HttpOnly preview cookie — used by join APIs. */
export function newVisitorFoundingAllowedFromRequest(
  req: Request,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): boolean {
  const url = new URL(req.url);
  return newVisitorFoundingAllowed(
    now,
    promoPreviewTokenFromSearch(url.searchParams),
    env,
    promoPreviewCookieFromHeader(req.headers.get('cookie')),
  );
}
