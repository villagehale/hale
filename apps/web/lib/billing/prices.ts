import type { BillingCurrency, BillingPeriod } from '@hale/types';
import {
  isFoundingPromoWindowOpen,
  parseFoundingPromoEndsAt,
} from '@hale/types';
import { holidayPromoEnabled } from './flags.js';

/**
 * Env-driven Stripe price selection for the holiday promo and the USD list path.
 *
 * Amounts are never read here. Founding CAD/USD yearly ids and Plus USD
 * monthly/annual ids arrive as STRIPE_PRICE_* env. CAD Plus list ids reuse the
 * existing STRIPE_PRICE_PLUS_{MONTHLY,ANNUAL} vars.
 *
 * During the founding window a US visitor with no USD list ids still gets the
 * founding yearly price. After the window, new checkouts never pick founding;
 * a subscription that already sits on a founding price is left alone.
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

export function foundingPromoEndsAt(
  env: Record<string, string | undefined> = process.env,
): Date {
  return parseFoundingPromoEndsAt(env[PROMO_FOUNDING_ENDS_AT_ENV]);
}

export function foundingPromoOpen(
  now: Date,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return holidayPromoEnabled(env) && isFoundingPromoWindowOpen(now, foundingPromoEndsAt(env));
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

/**
 * Price ids that grant Plus, including founding and USD list. Fed to the
 * webhook's price→tier map so invoice.paid on a founding price still applies
 * plus after the cutoff.
 */
export function plusPriceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const ids = [
    trimId(env.STRIPE_PRICE_PLUS_MONTHLY),
    trimId(env.STRIPE_PRICE_PLUS_ANNUAL),
    trimId(env[STRIPE_PRICE_PLUS_MONTHLY_USD_ENV]),
    trimId(env[STRIPE_PRICE_PLUS_ANNUAL_USD_ENV]),
    trimId(env[STRIPE_PRICE_FOUNDING_ANNUAL_CAD_ENV]),
    trimId(env[STRIPE_PRICE_FOUNDING_ANNUAL_USD_ENV]),
  ];
  return ids.filter((id): id is string => id !== null);
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
 * 1. Flag off → unavailable (the route 404s).
 * 2. Window open and a founding yearly id exists for the currency → founding.
 *    An explicit monthly request uses the USD/CAD list monthly id when set;
 *    otherwise it still falls through to founding yearly (the US list may be
 *    unset while the founding yearly is live).
 * 3. Otherwise the list price for that currency, then CAD as the fallback.
 */
export function resolveCheckoutPrice(input: {
  currency: BillingCurrency;
  period: BillingPeriod;
  now: Date;
  env?: Record<string, string | undefined>;
}): ResolveCheckoutPriceResult {
  const env = input.env ?? process.env;
  if (!holidayPromoEnabled(env)) {
    return { status: 'unavailable', reason: 'flag_off' };
  }

  const foundingId = foundingAnnualPriceId(input.currency, env);
  if (foundingPromoOpen(input.now, env) && foundingId) {
    if (input.period === 'monthly') {
      const monthly = listSelection(input.currency, 'monthly', env);
      if (monthly) return { status: 'selected', price: monthly };
    }
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

  const native = listSelection(input.currency, input.period, env);
  if (native) return { status: 'selected', price: native };
  if (input.currency !== 'CAD') {
    const cad = listSelection('CAD', input.period, env);
    if (cad) return { status: 'selected', price: cad };
  }
  return { status: 'unavailable', reason: 'no_price' };
}
