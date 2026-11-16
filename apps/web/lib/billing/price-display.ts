import type { BillingCurrency } from '@hale/types';
import { MAX_LIST_PRICE_DISPLAY, PLUS_LIST_PRICE_DISPLAY, PROMO_PRICE_DISPLAY } from '@hale/types';

/**
 * Hale-web price labels. Promo surfaces use a plain `$` with no CAD/USD note.
 * Currency still comes from visitor geo at checkout. List amounts come from
 * PLUS_LIST_PRICE_DISPLAY cents.
 */

export function promoPriceLabel(tier: 'plus' | 'family', currency: BillingCurrency): string {
  return PROMO_PRICE_DISPLAY[tier][currency].perYear;
}

/** Plus promo yearly label. Prefer promoPriceLabel when the tier is known. */
export function foundingPriceLabel(currency: BillingCurrency): string {
  return promoPriceLabel('plus', currency);
}

export function plusListPriceLabels(currency: BillingCurrency): {
  monthly: string;
  annual: string;
} {
  const row = PLUS_LIST_PRICE_DISPLAY[currency];
  return {
    monthly: `$${row.monthlyCents / 100}/mo`,
    annual: `$${row.annualCents / 100}/yr`,
  };
}

export function maxListPriceLabel(currency: BillingCurrency): string {
  return `$${MAX_LIST_PRICE_DISPLAY[currency].annualCents / 100}/yr`;
}
