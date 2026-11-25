import { type BillingCurrency, MAX_LIST_PRICE_DISPLAY, PLUS_LIST_PRICE_DISPLAY } from '@hale/types';
import { FOUNDING_REFUND_LINE, type HolidayPromo } from '~/lib/promo/holiday';

/**
 * Non-promo price sentences. Amounts come from the list display in @hale/types.
 * The label is already a plain "$"; this module only picks the visitor's row.
 * Max has an annual amount and no monthly amount in that table.
 */

export const REFUND_LINE = FOUNDING_REFUND_LINE;

/** Plus and Max are the paid tiers, refund anytime. No prices invented, and no price-word pitch. */
export const PAID_PLANS_LINE =
  'Paid plans are Plus and Max. Full refund anytime if it’s not for you.';

export const TEXTING_COST_ANSWER = PAID_PLANS_LINE;

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
  return `Plus is ${plusMonthlyLabel(currency)} or ${plusAnnualLabel(currency)}, and Max is ${maxAnnualLabel(currency)}. ${REFUND_LINE}`;
}

/**
 * The FAQ's "What do paid plans cost?" sentence, and the FAQPage JSON-LD that
 * repeats it. Yearly only. While the English promo is on, the sale labels;
 * otherwise the list annual labels for the visitor's currency. Both come from
 * the pricing page's helpers. A promo in another currency is ignored, and
 * French and Chinese pass null so the promo stays English-only.
 * JSON-LD is built in the same request as the row, so it is the price the
 * page renders for that geo.
 */
export function paidPlansYearlyAnswer(
  currency: BillingCurrency,
  promo: HolidayPromo | null = null,
): string {
  const plus =
    promo && promo.currency === currency ? promo.plus.saleLabel : plusAnnualLabel(currency);
  const max = promo && promo.currency === currency ? promo.max.saleLabel : maxAnnualLabel(currency);
  return `Plus is ${plus}, and Max is ${max}. ${REFUND_LINE}`;
}
