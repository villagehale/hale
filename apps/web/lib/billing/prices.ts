import type { BillingCurrency, BillingPeriod } from '@hale/types';
import {
  BLACK_FRIDAY_PRICE_DISPLAY,
  isBlackFridayWindowOpen,
  isFoundingPromoWindowOpen,
  parseFoundingPromoEndsAt,
} from '@hale/types';
import { checkoutServerCurrencyEnabled, holidayPromoEnabled } from './flags.js';
import { promoPriceLabel } from './price-display.js';
import { stripePaymentLinkUrl } from './promo-preview.js';

export type PaidTier = 'plus' | 'family';

/**
 * Env-driven Stripe price selection for the holiday promo and the USD list path.
 *
 * Amounts are never read here. Promo yearly ids arrive as
 * STRIPE_PRICE_PROMO_{PLUS,MAX}_ANNUAL_{CAD,USD}. Leftover
 * STRIPE_PRICE_FOUNDING_ANNUAL_* names are not selected for checkout, not
 * on the grant map, and not in the lockdown keep-alive set. After the
 * cutoff, Max list annual ids (`STRIPE_PRICE_MAX_ANNUAL_{CAD,USD}`) are
 * purchasable.
 *
 * During the window every new checkout is that tier's promo yearly price for
 * the visitor's currency — never a list or monthly id, even if the client asked.
 * Missing promo id is unavailable (never a silent list charge). After the
 * window, new checkouts never pick promo; a subscription that already sits
 * on a promo price is left alone.
 */

export const STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD_ENV = 'STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD';
export const STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD_ENV = 'STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD';
export const STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD_ENV = 'STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD';
export const STRIPE_PRICE_PROMO_MAX_ANNUAL_USD_ENV = 'STRIPE_PRICE_PROMO_MAX_ANNUAL_USD';
export const STRIPE_PRICE_FOUNDING_ANNUAL_CAD_ENV = 'STRIPE_PRICE_FOUNDING_ANNUAL_CAD';
export const STRIPE_PRICE_FOUNDING_ANNUAL_USD_ENV = 'STRIPE_PRICE_FOUNDING_ANNUAL_USD';
export const STRIPE_PRICE_PLUS_MONTHLY_USD_ENV = 'STRIPE_PRICE_PLUS_MONTHLY_USD';
export const STRIPE_PRICE_PLUS_ANNUAL_USD_ENV = 'STRIPE_PRICE_PLUS_ANNUAL_USD';
export const STRIPE_PRICE_MAX_ANNUAL_CAD_ENV = 'STRIPE_PRICE_MAX_ANNUAL_CAD';
export const STRIPE_PRICE_MAX_ANNUAL_USD_ENV = 'STRIPE_PRICE_MAX_ANNUAL_USD';
export const STRIPE_PRICE_BF_PLUS_ANNUAL_CAD_ENV = 'STRIPE_PRICE_BF_PLUS_ANNUAL_CAD';
export const STRIPE_PRICE_BF_PLUS_ANNUAL_USD_ENV = 'STRIPE_PRICE_BF_PLUS_ANNUAL_USD';
export const STRIPE_PRICE_BF_MAX_ANNUAL_CAD_ENV = 'STRIPE_PRICE_BF_MAX_ANNUAL_CAD';
export const STRIPE_PRICE_BF_MAX_ANNUAL_USD_ENV = 'STRIPE_PRICE_BF_MAX_ANNUAL_USD';
export const PROMO_FOUNDING_ENDS_AT_ENV = 'PROMO_FOUNDING_ENDS_AT';

export type CheckoutSku =
  | 'promo_plus_annual'
  | 'promo_max_annual'
  | 'bf_plus_annual'
  | 'bf_max_annual'
  | 'plus_monthly'
  | 'plus_annual'
  | 'max_annual';

export const CHECKOUT_SKU_PERIOD: Readonly<Record<CheckoutSku, BillingPeriod>> = {
  promo_plus_annual: 'annual',
  promo_max_annual: 'annual',
  bf_plus_annual: 'annual',
  bf_max_annual: 'annual',
  plus_monthly: 'monthly',
  plus_annual: 'annual',
  max_annual: 'annual',
};

export interface CheckoutPrice {
  readonly priceId: string;
  readonly sku: CheckoutSku;
  readonly currency: BillingCurrency;
  readonly period: BillingPeriod;
}

export type ResolveCheckoutPriceResult =
  | { status: 'selected'; price: CheckoutPrice }
  | { status: 'unavailable'; reason: 'flag_off' | 'no_price' };

function trimId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function foundingPromoEndsAt(env: Record<string, string | undefined> = process.env): Date {
  return parseFoundingPromoEndsAt(env[PROMO_FOUNDING_ENDS_AT_ENV]);
}

export function foundingPromoOpen(
  now: Date,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return holidayPromoEnabled(env) && isFoundingPromoWindowOpen(now, foundingPromoEndsAt(env));
}

/** Time window only. Does not consult HOLIDAY_PROMO_ENABLED. */
export function foundingWindowOpen(
  now: Date,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isFoundingPromoWindowOpen(now, foundingPromoEndsAt(env));
}

/**
 * The old Dashboard Payment Link URL, if anyone still has it in env.
 * Always null during the founding window — never serve or redirect to it
 * while the promo is active.
 */
export function paymentLinkUrlWhilePromoAllows(
  now: Date,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (foundingWindowOpen(now, env)) return null;
  return stripePaymentLinkUrl(env);
}

/** `max` is the public name for PlanTier `family`. Unrecognised values are Plus. */
export function paidTierFromUnknown(value: unknown): PaidTier {
  if (value === 'family' || value === 'max') return 'family';
  return 'plus';
}

/**
 * Case-insensitive plus / max / family. Anything else, including a present
 * unknown string, is null so checkout can answer 400 instead of selling Plus.
 * Omitted (undefined / null) is also null; the route treats that as Plus only
 * when the caller sent no tier at all.
 */
export function parsePaidTier(value: unknown): PaidTier | null {
  if (typeof value !== 'string') return null;
  const token = value.trim().toLowerCase();
  if (token === 'plus') return 'plus';
  if (token === 'family' || token === 'max') return 'family';
  return null;
}

export function isPromoAnnualSku(sku: CheckoutSku): boolean {
  return (
    sku === 'promo_plus_annual' ||
    sku === 'promo_max_annual' ||
    sku === 'bf_plus_annual' ||
    sku === 'bf_max_annual'
  );
}

export function paidTierFromSku(sku: CheckoutSku): PaidTier {
  return sku === 'promo_max_annual' || sku === 'max_annual' || sku === 'bf_max_annual'
    ? 'family'
    : 'plus';
}

export function promoPlusAnnualPriceId(
  currency: BillingCurrency,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return currency === 'USD'
    ? trimId(env[STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD_ENV])
    : trimId(env[STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD_ENV]);
}

export function promoMaxAnnualPriceId(
  currency: BillingCurrency,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return currency === 'USD'
    ? trimId(env[STRIPE_PRICE_PROMO_MAX_ANNUAL_USD_ENV])
    : trimId(env[STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD_ENV]);
}

export function promoAnnualPriceId(
  tier: PaidTier,
  currency: BillingCurrency,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return tier === 'family'
    ? promoMaxAnnualPriceId(currency, env)
    : promoPlusAnnualPriceId(currency, env);
}

/** Black Friday yearly id for one tier and currency. Null when the env var is unset. */
export function bfAnnualPriceId(
  tier: PaidTier,
  currency: BillingCurrency,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (tier === 'family') {
    return currency === 'USD'
      ? trimId(env[STRIPE_PRICE_BF_MAX_ANNUAL_USD_ENV])
      : trimId(env[STRIPE_PRICE_BF_MAX_ANNUAL_CAD_ENV]);
  }
  return currency === 'USD'
    ? trimId(env[STRIPE_PRICE_BF_PLUS_ANNUAL_USD_ENV])
    : trimId(env[STRIPE_PRICE_BF_PLUS_ANNUAL_CAD_ENV]);
}

export function bfPlusPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    trimId(env[STRIPE_PRICE_BF_PLUS_ANNUAL_CAD_ENV]),
    trimId(env[STRIPE_PRICE_BF_PLUS_ANNUAL_USD_ENV]),
  ].filter((id): id is string => id !== null);
}

export function bfMaxPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    trimId(env[STRIPE_PRICE_BF_MAX_ANNUAL_CAD_ENV]),
    trimId(env[STRIPE_PRICE_BF_MAX_ANNUAL_USD_ENV]),
  ].filter((id): id is string => id !== null);
}

export function bfPriceIdsFromEnv(env: Record<string, string | undefined> = process.env): string[] {
  return [...new Set([...bfPlusPriceIdsFromEnv(env), ...bfMaxPriceIdsFromEnv(env)])];
}

export function plusListPriceId(
  currency: BillingCurrency,
  period: BillingPeriod,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (currency === 'USD') {
    return period === 'annual'
      ? trimId(env[STRIPE_PRICE_PLUS_ANNUAL_USD_ENV])
      : trimId(env[STRIPE_PRICE_PLUS_MONTHLY_USD_ENV]);
  }
  return period === 'annual'
    ? trimId(env.STRIPE_PRICE_PLUS_ANNUAL)
    : trimId(env.STRIPE_PRICE_PLUS_MONTHLY);
}

/** Legacy $79/$59 ids. Lockdown archives them; checkout and grants ignore them. */
export function leftoverFoundingPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    trimId(env[STRIPE_PRICE_FOUNDING_ANNUAL_CAD_ENV]),
    trimId(env[STRIPE_PRICE_FOUNDING_ANNUAL_USD_ENV]),
  ].filter((id): id is string => id !== null);
}

export function promoPlusPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    trimId(env[STRIPE_PRICE_PROMO_PLUS_ANNUAL_CAD_ENV]),
    trimId(env[STRIPE_PRICE_PROMO_PLUS_ANNUAL_USD_ENV]),
  ].filter((id): id is string => id !== null);
}

export function promoMaxPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    trimId(env[STRIPE_PRICE_PROMO_MAX_ANNUAL_CAD_ENV]),
    trimId(env[STRIPE_PRICE_PROMO_MAX_ANNUAL_USD_ENV]),
  ].filter((id): id is string => id !== null);
}

/** The four promo yearly ids. Leftover founding names are not in this set. */
export function promoPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [...new Set([...promoPlusPriceIdsFromEnv(env), ...promoMaxPriceIdsFromEnv(env)])];
}

/** @deprecated Prefer promoPriceIdsFromEnv. */
export function foundingPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return promoPriceIdsFromEnv(env);
}

/** Plus list monthly/annual ids. Never a promo yearly id. */
export function listPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    trimId(env.STRIPE_PRICE_PLUS_MONTHLY),
    trimId(env.STRIPE_PRICE_PLUS_ANNUAL),
    trimId(env[STRIPE_PRICE_PLUS_MONTHLY_USD_ENV]),
    trimId(env[STRIPE_PRICE_PLUS_ANNUAL_USD_ENV]),
  ].filter((id): id is string => id !== null);
}

export function maxListAnnualPriceId(
  currency: BillingCurrency,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (currency === 'USD') return trimId(env[STRIPE_PRICE_MAX_ANNUAL_USD_ENV]);
  return trimId(env[STRIPE_PRICE_MAX_ANNUAL_CAD_ENV]);
}

/** Family/Max list ids. Allowed after the cutoff; refused during the window. */
export function familyPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    trimId(env.STRIPE_PRICE_FAMILY_MONTHLY),
    trimId(env.STRIPE_PRICE_FAMILY_ANNUAL),
    trimId(env[STRIPE_PRICE_MAX_ANNUAL_CAD_ENV]),
    trimId(env[STRIPE_PRICE_MAX_ANNUAL_USD_ENV]),
  ].filter((id): id is string => id !== null);
}

/**
 * Price ids that grant Plus, including promo Plus yearly and USD list.
 * Fed to the webhook's price→tier map so invoice.paid on a promo Plus price
 * still applies plus after the cutoff. Max promo ids and leftover founding
 * $79/$59 ids are not in this list.
 */
export function plusPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    ...listPriceIdsFromEnv(env),
    ...promoPlusPriceIdsFromEnv(env),
    ...bfPlusPriceIdsFromEnv(env),
  ];
}

export function isPromoPriceId(
  priceId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return promoPriceIdsFromEnv(env).includes(priceId) || bfPriceIdsFromEnv(env).includes(priceId);
}

/** @deprecated Prefer isPromoPriceId. */
export function isFoundingPriceId(
  priceId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return isPromoPriceId(priceId, env);
}

/**
 * A promo subscription created inside the window keeps this price on every
 * later invoice. There is no switch to the list annual price at renewal.
 */
export function renewalPriceIdForSubscription(
  existingPriceId: string,
  now: Date,
  env: Record<string, string | undefined> = process.env,
): string {
  void now;
  void env;
  return existingPriceId;
}

function listSelection(
  currency: BillingCurrency,
  period: BillingPeriod,
  env: Record<string, string | undefined>,
): CheckoutPrice | null {
  const priceId = plusListPriceId(currency, period, env);
  if (!priceId) return null;
  return {
    priceId,
    sku: period === 'annual' ? 'plus_annual' : 'plus_monthly',
    currency,
    period,
  };
}

function promoSelection(
  tier: PaidTier,
  currency: BillingCurrency,
  env: Record<string, string | undefined>,
): CheckoutPrice | null {
  const priceId = promoAnnualPriceId(tier, currency, env);
  if (!priceId) return null;
  return {
    priceId,
    sku: tier === 'family' ? 'promo_max_annual' : 'promo_plus_annual',
    currency,
    period: 'annual',
  };
}

function bfSelection(
  tier: PaidTier,
  currency: BillingCurrency,
  env: Record<string, string | undefined>,
): CheckoutPrice | null {
  const priceId = bfAnnualPriceId(tier, currency, env);
  if (!priceId) return null;
  return {
    priceId,
    sku: tier === 'family' ? 'bf_max_annual' : 'bf_plus_annual',
    currency,
    period: 'annual',
  };
}

function maxListSelection(
  currency: BillingCurrency,
  env: Record<string, string | undefined>,
): CheckoutPrice | null {
  const priceId = maxListAnnualPriceId(currency, env);
  if (!priceId) return null;
  return {
    priceId,
    sku: 'max_annual',
    currency,
    period: 'annual',
  };
}

/**
 * Pick the Stripe price for a new checkout.
 *
 * 1. Flag off and not a preview caller → unavailable (the route 404s).
 * 2. Window open → that tier's promo yearly for the visitor's currency.
 *    Client period / list / monthly env ids are ignored. Missing promo id
 *    is unavailable.
 * 3. After the window, Plus uses that currency's list price. USD list is
 *    US$14/mo (`STRIPE_PRICE_PLUS_MONTHLY_USD`) or US$119/yr
 *    (`STRIPE_PRICE_PLUS_ANNUAL_USD`). When CHECKOUT_SERVER_CURRENCY_ENABLED
 *    is exactly `true`, a missing USD id is `no_price` — never the CAD id.
 *    With the flag off, USD still falls back to CAD. Max uses only that
 *    currency's dedicated `STRIPE_PRICE_MAX_ANNUAL_*` id — never CAD-for-USD,
 *    never `STRIPE_PRICE_FAMILY_ANNUAL`, never Plus list. Missing is
 *    unavailable. Preview callers do not get list prices after the cutoff.
 */
export function resolveCheckoutPrice(input: {
  currency: BillingCurrency;
  period: BillingPeriod;
  now: Date;
  env?: Record<string, string | undefined>;
  /** Listed family or /join?preview= token while the live flags stay off. */
  preview?: boolean;
  /** Paid tier to sell. Defaults to plus. `max` is accepted via paidTierFromUnknown. */
  tier?: PaidTier;
}): ResolveCheckoutPriceResult {
  const env = input.env ?? process.env;
  const tier = input.tier ?? 'plus';
  if (!holidayPromoEnabled(env) && !input.preview) {
    return { status: 'unavailable', reason: 'flag_off' };
  }

  // Price gate [2026-11-27T05:00Z, 2026-11-28T08:00Z). The holiday flag stays
  // required, so a preview tester with the flag off keeps the season price.
  // A missing BF id falls through.
  if (holidayPromoEnabled(env) && isBlackFridayWindowOpen(input.now)) {
    const bf = bfSelection(tier, input.currency, env);
    if (bf) return { status: 'selected', price: bf };
  }

  if (foundingWindowOpen(input.now, env)) {
    const promo = promoSelection(tier, input.currency, env);
    if (!promo) return { status: 'unavailable', reason: 'no_price' };
    return { status: 'selected', price: promo };
  }

  if (!holidayPromoEnabled(env)) {
    return { status: 'unavailable', reason: 'flag_off' };
  }

  if (tier === 'family') {
    const maxNative = maxListSelection(input.currency, env);
    if (maxNative) return { status: 'selected', price: maxNative };
    return { status: 'unavailable', reason: 'no_price' };
  }

  const native = listSelection(input.currency, input.period, env);
  if (native) return { status: 'selected', price: native };
  if (!checkoutServerCurrencyEnabled(env) && input.currency !== 'CAD') {
    const cad = listSelection('CAD', input.period, env);
    if (cad) return { status: 'selected', price: cad };
  }
  return { status: 'unavailable', reason: 'no_price' };
}

/** The yearly label checkout will charge. The one-day price, or the season price. */
export function chargedAnnualLabel(input: {
  tier: PaidTier;
  currency: BillingCurrency;
  now: Date;
  env?: Record<string, string | undefined>;
  preview?: boolean;
}): string {
  const selected = resolveCheckoutPrice({ ...input, period: 'annual' });
  if (
    selected.status === 'selected' &&
    (selected.price.sku === 'bf_plus_annual' || selected.price.sku === 'bf_max_annual')
  ) {
    const key = selected.price.sku === 'bf_max_annual' ? 'family' : 'plus';
    return BLACK_FRIDAY_PRICE_DISPLAY[key][input.currency].perYear;
  }
  return promoPriceLabel(input.tier, input.currency);
}
