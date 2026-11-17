import { type BillingCurrency, currencyFromIpCountry, serverCheckoutCurrency } from '@hale/types';
import { checkoutServerCurrencyEnabled } from './flags.js';
import { type PaidTier, paidTierFromUnknown, parsePaidTier } from './prices.js';

/**
 * Currency for a checkout POST.
 *
 * Flag off: US → USD, everything else → CAD. A client `expectedCurrency` is
 * only a mismatch check; it never picks the price.
 *
 * Flag on (CHECKOUT_SERVER_CURRENCY_ENABLED exactly `true`): the server
 * currency is US → USD and CA → CAD. Anything else, including a client-sent
 * currency, is refused. A client currency that disagrees with geo is refused
 * and is not charged.
 */
export type CheckoutCurrencyDecision =
  | { status: 'ok'; currency: BillingCurrency }
  | { status: 'currency_required' }
  | { status: 'currency_changed' };

export function decideCheckoutCurrency(input: {
  countryHeader: string | null;
  expectedCurrency: unknown;
  env?: Record<string, string | undefined>;
}): CheckoutCurrencyDecision {
  const env = input.env ?? process.env;
  if (!checkoutServerCurrencyEnabled(env)) {
    const currency = currencyFromIpCountry(input.countryHeader);
    if (input.expectedCurrency !== undefined && input.expectedCurrency !== currency) {
      return { status: 'currency_changed' };
    }
    return { status: 'ok', currency };
  }

  const currency = serverCheckoutCurrency(input.countryHeader);
  if (!currency) return { status: 'currency_required' };
  if (input.expectedCurrency !== undefined && input.expectedCurrency !== currency) {
    return { status: 'currency_changed' };
  }
  return { status: 'ok', currency };
}

export type CheckoutTierDecision = { status: 'ok'; tier: PaidTier } | { status: 'invalid_tier' };

/**
 * Flag off: unknown and omitted tiers sell Plus (the historical default).
 * Flag on: `Max` / `max` / `family` are Max, `plus` is Plus, and any other
 * present value is invalid. An omitted tier stays Plus so a caller that
 * never sent one is not sold a surprise plan name.
 */
export function decideCheckoutTier(
  value: unknown,
  env: Record<string, string | undefined> = process.env,
): CheckoutTierDecision {
  if (!checkoutServerCurrencyEnabled(env)) {
    return { status: 'ok', tier: paidTierFromUnknown(value) };
  }
  if (value === undefined || value === null) return { status: 'ok', tier: 'plus' };
  const tier = parsePaidTier(value);
  if (!tier) return { status: 'invalid_tier' };
  return { status: 'ok', tier };
}
