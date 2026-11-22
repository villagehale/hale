import { safeHttpUrl } from '~/lib/format/http-url';

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
  /** Verified paid tier from session metadata. `family` is Max. */
  readonly tier: 'plus' | 'family' | null;
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

function paidTierFromSession(payload: Record<string, unknown>): 'plus' | 'family' | null {
  const metadata = isRecord(payload.metadata) ? payload.metadata : null;
  const raw = metadata ? readString(metadata.tier) : null;
  if (raw === 'plus') return 'plus';
  if (raw === 'family' || raw === 'max') return 'family';
  return null;
}

/**
 * Reads amount_total (cents), currency, and metadata.tier off a Checkout Session.
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
    tier: paidTierFromSession(payload),
  };
}

export function checkoutSuccessUrl(marketingOrigin: string): string {
  const base = marketingOrigin.replace(/\/$/, '');
  return `${base}/checkout/success?session_id=${CHECKOUT_SESSION_ID_PLACEHOLDER}`;
}

/** State H: the pricing page says no charge was made. */
export function checkoutCancelUrl(marketingOrigin: string): string {
  return `${marketingOrigin.replace(/\/$/, '')}/pricing?checkout=cancelled`;
}

function isProductionMarketingOrigin(raw: string): boolean {
  const url = safeHttpUrl(raw);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== 'villagehale.com' && host !== 'www.villagehale.com') return false;
    return parsed.pathname === '/' && parsed.search === '' && parsed.hash === '';
  } catch {
    return false;
  }
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
  if (raw && !isProductionMarketingOrigin(raw)) return raw;
  return productionOrigin;
}
