/**
 * Paid Stripe Checkout Session facts for the browser Google Ads conversion.
 *
 * Value and currency come from Stripe, never from the success-page query string.
 * transaction_id is the Checkout Session id. The marketing success page fires
 * gtag; this module only reads the session.
 */

export const CHECKOUT_SESSION_ID_PLACEHOLDER = '{CHECKOUT_SESSION_ID}';

const SESSION_ID = /^cs_[A-Za-z0-9_]+$/;

export interface PaidCheckoutFacts {
  readonly transactionId: string;
  readonly value: number;
  readonly currency: string;
  readonly paid: boolean;
}

export function checkoutSessionIdFromUnknown(raw: unknown): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return null;
  const id = value.trim();
  return SESSION_ID.test(id) ? id : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Reads amount_total (cents) and currency off a Checkout Session object.
 * `paid` is true only for payment_status=paid — an unpaid session must not fire.
 */
export function paidCheckoutFactsFromStripeSession(payload: unknown): PaidCheckoutFacts | null {
  if (!isRecord(payload)) return null;
  const transactionId = readString(payload.id);
  const currency = readString(payload.currency)?.toUpperCase();
  const amountTotal = readNumber(payload.amount_total);
  if (!transactionId || !SESSION_ID.test(transactionId) || !currency || amountTotal === null) {
    return null;
  }
  return {
    transactionId,
    value: amountTotal / 100,
    currency,
    paid: readString(payload.payment_status) === 'paid',
  };
}

export function checkoutSuccessUrl(marketingOrigin: string): string {
  const base = marketingOrigin.replace(/\/$/, '');
  return `${base}/checkout/success?session_id=${CHECKOUT_SESSION_ID_PLACEHOLDER}`;
}

/**
 * Production uses www.villagehale.com (the apex 308s). Local/preview may override
 * with NEXT_PUBLIC_MARKETING_URL.
 */
export function checkoutMarketingOrigin(
  productionOrigin: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.NEXT_PUBLIC_MARKETING_URL?.trim().replace(/\/$/, '');
  if (raw && !/^https:\/\/(www\.)?villagehale\.com$/i.test(raw)) return raw;
  return productionOrigin;
}
