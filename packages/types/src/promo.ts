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
export function currencyFromIpCountry(countryHeader: string | null | undefined): BillingCurrency {
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

/** First moment the founding offer shows: 2026-11-16 00:00 America/Toronto. */
export const FOUNDING_PROMO_STARTS_AT = '2026-11-16T00:00:00-05:00';

/** "Black Friday Sale" becomes "Holiday Sale" at 2026-11-28 00:00 America/Toronto. */
export const HOLIDAY_SALE_STARTS_AT = '2026-11-28T00:00:00-05:00';

export type PromoPhase = 'black_friday' | 'holiday';

export function promoPhaseAt(now: Date): PromoPhase {
  return now.getTime() < new Date(HOLIDAY_SALE_STARTS_AT).getTime() ? 'black_friday' : 'holiday';
}

/**
 * What the founding price LOOKS like on a page. Display only: checkout charges
 * the Stripe price id in env (STRIPE_PRICE_FOUNDING_ANNUAL_*), so a change to
 * the amount has to land in Stripe and here together.
 */
export const FOUNDING_PRICE_DISPLAY: Record<
  BillingCurrency,
  { symbol: 'C$' | 'US$'; amount: number; perYear: string }
> = {
  CAD: { symbol: 'C$', amount: 79, perYear: 'C$79/yr' },
  USD: { symbol: 'US$', amount: 59, perYear: 'US$59/yr' },
};

/** The line every Canadian promo surface carries. US surfaces show none. */
export const CANADA_PLUS_AFTER_LINE = 'Plus is C$159/yr after Dec 31.';
