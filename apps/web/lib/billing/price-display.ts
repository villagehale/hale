import type { BillingCurrency } from '@hale/types';
import { FOUNDING_PRICE_DISPLAY, PLUS_LIST_PRICE_DISPLAY } from '@hale/types';

/**
 * Hale-web price labels. Plain `$` plus a CAD/USD note (same geo-IP currency
 * as checkout). Marketing-site C$/US$ strings in `@hale/types` stay put until
 * #1285 retargets villagehale.com.
 */

export function foundingPriceLabel(currency: BillingCurrency): string {
  return `$${FOUNDING_PRICE_DISPLAY[currency].amount}/yr`;
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
