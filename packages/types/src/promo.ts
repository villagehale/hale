/**
 * Holiday 2026 founding-family promo window and visitor currency.
 *
 * Amounts stay out of this module: checkout reads Stripe price ids from env.
 * The cutoff only stops NEW founding checkouts. A subscription that already
 * sits on a founding price keeps renewing on that price after the window.
 * The promo is only that yearly price, locked for life — no referral program
 * and no gift-a-year.
 */

/** ISO-4217 currencies Hale bills in. */
export type BillingCurrency = 'CAD' | 'USD';

/**
 * Default end of the founding-family offer: 2026-12-31 23:59 America/Toronto
 * (EST, UTC−5). Override with PROMO_FOUNDING_ENDS_AT.
 */
export const DEFAULT_FOUNDING_PROMO_ENDS_AT = '2026-12-31T23:59:00-05:00';

/**
 * US → USD; every other country code, and a missing header, → CAD.
 * Reads Vercel's `x-vercel-ip-country` value (ISO 3166-1 alpha-2).
 */
export function currencyFromIpCountry(
  countryHeader: string | null | undefined,
): BillingCurrency {
  const country = countryHeader?.trim().toUpperCase();
  return country === 'US' ? 'USD' : 'CAD';
}

/** Parse an override timestamp, or the Toronto default when unset/invalid. */
export function parseFoundingPromoEndsAt(
  raw: string | null | undefined,
  fallback: string = DEFAULT_FOUNDING_PROMO_ENDS_AT,
): Date {
  const candidate = raw?.trim() ? new Date(raw.trim()) : new Date(fallback);
  if (Number.isNaN(candidate.getTime())) return new Date(fallback);
  return candidate;
}

/**
 * True while `now` is at or before the cutoff (the 23:59 minute is included).
 * Does not consult the env flag — callers combine this with HOLIDAY_PROMO_ENABLED.
 */
export function isFoundingPromoWindowOpen(
  now: Date,
  endsAt: Date = parseFoundingPromoEndsAt(undefined),
): boolean {
  return now.getTime() <= endsAt.getTime();
}
