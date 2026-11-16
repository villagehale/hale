/**
 * Holiday 2026 founding-family promo window and visitor currency.
 *
 * Amounts stay out of checkout: that path reads Stripe price ids from env.
 * Display amounts below are for Plan / marketing copy. CAD Plus list cents are
 * not in env (`STRIPE_PRICE_PLUS_ANNUAL` is an id); they match the existing
 * public Plus copy. USD list cents match `pnpm stripe:create-prices`.
 *
 * The cutoff only stops NEW founding checkouts. A subscription that already
 * sits on a founding price keeps renewing on that price after the window.
 * The promo is only that yearly price, locked for life — no referral program
 * and no gift-a-year.
 */

/** ISO-4217 currencies Hale bills in. */
export type BillingCurrency = 'CAD' | 'USD';

/**
 * Exclusive end of the founding-family offer: 2027-01-01 00:00 America/Toronto
 * (EST, UTC−5). The last second of 31 Dec is inside the window. Override with
 * PROMO_FOUNDING_ENDS_AT.
 */
export const DEFAULT_FOUNDING_PROMO_ENDS_AT = '2027-01-01T00:00:00-05:00';

/**
 * Plus list display. CAD matches the existing public Plus copy for
 * STRIPE_PRICE_PLUS_{MONTHLY,ANNUAL}. USD matches create-prices (1400 / 11900).
 */
export const PLUS_LIST_PRICE_DISPLAY: Record<
  BillingCurrency,
  { monthlyLabel: string; annualLabel: string; monthlyCents: number; annualCents: number }
> = {
  CAD: {
    monthlyLabel: 'C$19/mo',
    annualLabel: 'C$159/yr',
    monthlyCents: 1900,
    annualCents: 15900,
  },
  USD: {
    monthlyLabel: 'US$14/mo',
    annualLabel: 'US$119/yr',
    monthlyCents: 1400,
    annualCents: 11900,
  },
};

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
 * True while `now` is strictly before the cutoff (exclusive end).
 * `2026-12-31 23:59:59` America/Toronto is open; `2027-01-01 00:00:00` is not.
 * Does not consult the env flag — callers combine this with HOLIDAY_PROMO_ENABLED.
 */
export function isFoundingPromoWindowOpen(
  now: Date,
  endsAt: Date = parseFoundingPromoEndsAt(undefined),
): boolean {
  return now.getTime() < endsAt.getTime();
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
 * the Stripe founding price ids in env (STRIPE_PRICE_FOUNDING_ANNUAL_*, CAD 7900 /
 * USD 5900), so a change to the amount has to land in Stripe and here together.
 *
 * Both countries show a plain "$" (Barton, Nov 16). The currency code rides
 * along quietly so the price is never ambiguous: `perYear` is "$79/yr" for the
 * big numeral, `perYearCode` is "$79/yr CAD" for every sentence and button.
 */
export const FOUNDING_PRICE_DISPLAY: Record<
  BillingCurrency,
  { symbol: '$'; amount: number; perYear: string; perYearCode: string; code: BillingCurrency }
> = {
  CAD: { symbol: '$', amount: 79, perYear: '$79/yr', perYearCode: '$79/yr CAD', code: 'CAD' },
  USD: { symbol: '$', amount: 59, perYear: '$59/yr', perYearCode: '$59/yr USD', code: 'USD' },
};

