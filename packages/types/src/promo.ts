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
 * Plus list display. Amounts are unchanged: CAD matches the public Plus price
 * for STRIPE_PRICE_PLUS_{MONTHLY,ANNUAL}; USD matches create-prices (1400 / 11900).
 * Labels are a plain "$" with no CAD/USD note. Callers pick the row from the
 * visitor's country.
 */
export const PLUS_LIST_PRICE_DISPLAY: Record<
  BillingCurrency,
  { monthlyLabel: string; annualLabel: string; monthlyCents: number; annualCents: number }
> = {
  CAD: {
    monthlyLabel: '$19/mo',
    annualLabel: '$159/yr',
    monthlyCents: 1900,
    annualCents: 15900,
  },
  USD: {
    monthlyLabel: '$14/mo',
    annualLabel: '$119/yr',
    monthlyCents: 1400,
    annualCents: 11900,
  },
};

/**
 * Max list annual display for after the promo cutoff. CAD 32900 / USD 25900
 * match `STRIPE_PRICE_MAX_ANNUAL_{CAD,USD}` from create-founding-prices.
 * Not purchasable during the window. Labels are a plain "$" with no currency
 * note; callers pick the row from the visitor's country. There is no monthly
 * Max amount in this table.
 */
export const MAX_LIST_PRICE_DISPLAY: Record<
  BillingCurrency,
  { annualLabel: string; annualCents: number }
> = {
  CAD: { annualLabel: '$329/yr', annualCents: 32900 },
  USD: { annualLabel: '$259/yr', annualCents: 25900 },
};

/**
 * US → USD; every other country code, and a missing header, → CAD.
 * Reads Vercel's `x-vercel-ip-country` value (ISO 3166-1 alpha-2).
 *
 * Display-only. The sale card keeps a bare `$`. Checkout does not use this
 * once CHECKOUT_SERVER_CURRENCY_ENABLED is exactly `true` — it uses
 * `serverCheckoutCurrency`, which refuses anything other than US or CA.
 */
export function currencyFromIpCountry(countryHeader: string | null | undefined): BillingCurrency {
  const country = countryHeader?.trim().toUpperCase();
  return country === 'US' ? 'USD' : 'CAD';
}

/** Shown instead of a buy button when checkout is refused for the visitor's country. */
export const CHECKOUT_REGION_UNSUPPORTED_MESSAGE =
  "Hale is only in the US and Canada for now. We'll let you know when it reaches you.";

/**
 * The currency the server will charge. US → USD, CA → CAD. A missing or empty
 * geo header keeps the CAD fallback. Any other explicit country is null — the
 * caller refuses checkout, with no USD/CAD fallback and no client-sent currency.
 */
export function serverCheckoutCurrency(
  countryHeader: string | null | undefined,
): BillingCurrency | null {
  const country = countryHeader?.trim().toUpperCase();
  if (!country) return 'CAD';
  if (country === 'US') return 'USD';
  if (country === 'CA') return 'CAD';
  return null;
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

/** Phase becomes "holiday" at 2026-12-01 00:00 America/Toronto. The label stays "Holiday Sale". */
export const HOLIDAY_SALE_STARTS_AT = '2026-12-01T00:00:00-05:00';

export type PromoPhase = 'black_friday' | 'holiday';

export function promoPhaseAt(now: Date): PromoPhase {
  return now.getTime() < new Date(HOLIDAY_SALE_STARTS_AT).getTime() ? 'black_friday' : 'holiday';
}

/**
 * Holiday 2026 promo annual amounts (display only). Checkout charges the Stripe
 * price ids in env (STRIPE_PRICE_PROMO_{PLUS,MAX}_ANNUAL_{CAD,USD}).
 *
 * Barton, Nov 16: Plus CAD $59 / USD $39, Max CAD $99 / USD $79, yearly only.
 * Promo surfaces show a plain "$" with no CAD/USD label; currency still comes
 * from visitor geo. `family` is the Max plan (PlanTier name).
 */
export const PROMO_PRICE_DISPLAY: Record<
  'plus' | 'family',
  Record<BillingCurrency, { symbol: '$'; amount: number; perYear: string }>
> = {
  plus: {
    CAD: { symbol: '$', amount: 59, perYear: '$59/yr' },
    USD: { symbol: '$', amount: 39, perYear: '$39/yr' },
  },
  family: {
    CAD: { symbol: '$', amount: 99, perYear: '$99/yr' },
    USD: { symbol: '$', amount: 79, perYear: '$79/yr' },
  },
};

/**
 * Site #1288 still reads this (Plus-only founding copy with a CAD/USD note).
 * Hale-web promo surfaces use PROMO_PRICE_DISPLAY and do not show a currency
 * code. Do not reuse these amounts on new promo UI.
 */
export const FOUNDING_PRICE_DISPLAY: Record<
  BillingCurrency,
  { symbol: '$'; amount: number; perYear: string; perYearCode: string; code: BillingCurrency }
> = {
  CAD: { symbol: '$', amount: 79, perYear: '$79/yr', perYearCode: '$79/yr CAD', code: 'CAD' },
  USD: { symbol: '$', amount: 59, perYear: '$59/yr', perYearCode: '$59/yr USD', code: 'USD' },
};
