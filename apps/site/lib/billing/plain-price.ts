import { type BillingCurrency, MAX_LIST_PRICE_DISPLAY, PLUS_LIST_PRICE_DISPLAY } from '@hale/types';
import { FOUNDING_REFUND_LINE } from '~/lib/promo/holiday';

/**
 * Non-promo price sentences. Amounts come from the list display in @hale/types.
 * The label is already a plain "$"; this module only picks the visitor's row.
 * Max has an annual amount and no monthly amount in that table.
 */

export const REFUND_LINE = FOUNDING_REFUND_LINE;

/** Free exists, Plus and Max are the paid tiers, refund anytime. No prices invented. */
export const FREE_TIER_LINE =
  'Free is $0, with unlimited chat. Paid plans are Plus and Max. Full refund anytime if it’s not for you.';

export const IS_IT_FREE_ANSWER =
  'Yes. There is a Free tier, with unlimited chat. Paid plans are Plus and Max. Full refund anytime if it’s not for you.';

export function plusMonthlyLabel(currency: BillingCurrency): string {
  return PLUS_LIST_PRICE_DISPLAY[currency].monthlyLabel;
}

export function plusAnnualLabel(currency: BillingCurrency): string {
  return PLUS_LIST_PRICE_DISPLAY[currency].annualLabel;
}

export function maxAnnualLabel(currency: BillingCurrency): string {
  return MAX_LIST_PRICE_DISPLAY[currency].annualLabel;
}

export function orAnnualLabel(currency: BillingCurrency): string {
  return `or ${plusAnnualLabel(currency)}`;
}

export function plusPriceSentence(currency: BillingCurrency): string {
  return `Plus is ${plusMonthlyLabel(currency)} or ${plusAnnualLabel(currency)}.`;
}

export function plusPriceStartSentence(currency: BillingCurrency): string {
  return `${plusPriceSentence(currency)} Text Hale to start.`;
}

export function plusCloseSentence(currency: BillingCurrency): string {
  return `${plusPriceSentence(currency)} ${REFUND_LINE}`;
}

/** Location-specific cost answer. Default geo (no header) is CAD, same as checkout. */
export function paidPlansCostAnswer(currency: BillingCurrency): string {
  return `Free is $0 with unlimited chat. Plus is ${plusMonthlyLabel(currency)} or ${plusAnnualLabel(currency)}, and Max is ${maxAnnualLabel(currency)}. ${REFUND_LINE}`;
}
