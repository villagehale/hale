import type { BillingCurrency, BillingPeriod } from '@hale/types';
import { isFoundingPromoWindowOpen, parseFoundingPromoEndsAt } from '@hale/types';
import { holidayPromoEnabled } from './flags.js';
import { stripePaymentLinkUrl } from './promo-preview.js';

/**
 * Env-driven Stripe price selection for the holiday promo and the USD list path.
 *
 * Amounts are never read here. Founding CAD/USD yearly ids and Plus USD
 * monthly/annual ids arrive as STRIPE_PRICE_* env. CAD Plus list ids reuse the
 * existing STRIPE_PRICE_PLUS_{MONTHLY,ANNUAL} vars.
 *
 * During the founding window every new checkout is the founding yearly price
 * for that currency — never a list or monthly id, even if the client asked.
 * Missing founding id is unavailable (never a silent list charge). After the
 * window, new checkouts never pick founding; a subscription that already sits
 * on a founding price is left alone.
 */

export const STRIPE_PRICE_FOUNDING_ANNUAL_CAD_ENV = 'STRIPE_PRICE_FOUNDING_ANNUAL_CAD';
export const STRIPE_PRICE_FOUNDING_ANNUAL_USD_ENV = 'STRIPE_PRICE_FOUNDING_ANNUAL_USD';
export const STRIPE_PRICE_PLUS_MONTHLY_USD_ENV = 'STRIPE_PRICE_PLUS_MONTHLY_USD';
export const STRIPE_PRICE_PLUS_ANNUAL_USD_ENV = 'STRIPE_PRICE_PLUS_ANNUAL_USD';
export const PROMO_FOUNDING_ENDS_AT_ENV = 'PROMO_FOUNDING_ENDS_AT';

export type CheckoutSku = 'founding_annual' | 'plus_monthly' | 'plus_annual';

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

export function foundingAnnualPriceId(
  currency: BillingCurrency,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return currency === 'USD'
    ? trimId(env[STRIPE_PRICE_FOUNDING_ANNUAL_USD_ENV])
    : trimId(env[STRIPE_PRICE_FOUNDING_ANNUAL_CAD_ENV]);
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

/** Founding yearly CAD/USD ids. Empty when those env vars are unset. */
export function foundingPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [
    trimId(env[STRIPE_PRICE_FOUNDING_ANNUAL_CAD_ENV]),
    trimId(env[STRIPE_PRICE_FOUNDING_ANNUAL_USD_ENV]),
  ].filter((id): id is string => id !== null);
}

/** Plus list monthly/annual ids. Never a founding yearly id. */
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

/** Family list monthly/annual ids. Allowed after the cutoff; refused during the window. */
export function familyPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [trimId(env.STRIPE_PRICE_FAMILY_MONTHLY), trimId(env.STRIPE_PRICE_FAMILY_ANNUAL)].filter(
    (id): id is string => id !== null,
  );
}

/**
 * Price ids that grant Plus, including founding and USD list. Fed to the
 * webhook's price→tier map so invoice.paid on a founding price still applies
 * plus after the cutoff.
 */
export function plusPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  return [...listPriceIdsFromEnv(env), ...foundingPriceIdsFromEnv(env)];
}

export function isFoundingPriceId(
  priceId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    priceId === trimId(env[STRIPE_PRICE_FOUNDING_ANNUAL_CAD_ENV]) ||
    priceId === trimId(env[STRIPE_PRICE_FOUNDING_ANNUAL_USD_ENV])
  );
}

/**
 * A founding subscription created inside the window keeps this price on every
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

/**
 * Pick the Stripe price for a new checkout.
 *
 * 1. Flag off and not a preview caller → unavailable (the route 404s).
 * 2. Window open → founding yearly for that currency. Client period / list /
 *    monthly env ids are ignored. Missing founding id is unavailable.
 * 3. After the window, the list price for that currency, then CAD as fallback.
 *    Preview callers do not get list prices after the cutoff.
 */
export function resolveCheckoutPrice(input: {
  currency: BillingCurrency;
  period: BillingPeriod;
  now: Date;
  env?: Record<string, string | undefined>;
  /** Listed family or /founding?preview= token while the live flags stay off. */
  preview?: boolean;
}): ResolveCheckoutPriceResult {
  const env = input.env ?? process.env;
  if (!holidayPromoEnabled(env) && !input.preview) {
    return { status: 'unavailable', reason: 'flag_off' };
  }

  if (foundingWindowOpen(input.now, env)) {
    const foundingId = foundingAnnualPriceId(input.currency, env);
    if (!foundingId) return { status: 'unavailable', reason: 'no_price' };
    return {
      status: 'selected',
      price: {
        priceId: foundingId,
        sku: 'founding_annual',
        currency: input.currency,
        period: 'annual',
      },
    };
  }

  if (!holidayPromoEnabled(env)) {
    return { status: 'unavailable', reason: 'flag_off' };
  }

  const native = listSelection(input.currency, input.period, env);
  if (native) return { status: 'selected', price: native };
  if (input.currency !== 'CAD') {
    const cad = listSelection('CAD', input.period, env);
    if (cad) return { status: 'selected', price: cad };
  }
  return { status: 'unavailable', reason: 'no_price' };
}
