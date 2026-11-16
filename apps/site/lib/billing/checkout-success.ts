import type { GooglePurchaseEvent } from '~/lib/analytics/google-purchase';
import type { MetaPurchaseEvent } from '~/lib/analytics/meta-purchase';
import { APP_URL } from '~/lib/app-url';

/**
 * Success-page helpers. Value and currency are fetched from the app's Stripe
 * retrieve — query params named value/currency are ignored on purpose.
 */

const SESSION_ID = /^cs_[A-Za-z0-9_]+$/;

export function checkoutSessionIdFromSearch(search: {
  session_id?: string | string[];
  value?: string | string[];
  currency?: string | string[];
}): string | null {
  void search.value;
  void search.currency;
  const raw = Array.isArray(search.session_id) ? search.session_id[0] : search.session_id;
  if (typeof raw !== 'string') return null;
  const id = raw.trim();
  return SESSION_ID.test(id) ? id : null;
}

export function conversionsApiEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.CONVERSIONS_API_ENABLED === 'true';
}

export function googleAdsConversionSendTo(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const sendTo = env.NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_SEND_TO?.trim();
  return sendTo ? sendTo : null;
}

export function metaPixelIdFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const id = env.NEXT_PUBLIC_META_PIXEL_ID?.trim();
  return id ? id : null;
}

export interface CheckoutSessionFacts {
  readonly transactionId: string;
  readonly value: number;
  readonly currency: string;
  readonly paid: boolean;
  /** Verified paid tier from the app's Stripe retrieve. `family` is Max. */
  readonly tier: 'plus' | 'family' | null;
}

export function googlePurchaseFromPaidSession(input: {
  facts: CheckoutSessionFacts;
  conversionsEnabled: boolean;
  sendTo: string | null;
}): GooglePurchaseEvent | null {
  if (!input.conversionsEnabled || !input.sendTo || !input.facts.paid) return null;
  if (!Number.isFinite(input.facts.value) || input.facts.value <= 0) return null;
  return {
    sendTo: input.sendTo,
    value: input.facts.value,
    currency: input.facts.currency,
    transactionId: input.facts.transactionId,
  };
}

export function metaPurchaseFromPaidSession(input: {
  facts: CheckoutSessionFacts;
  conversionsEnabled: boolean;
  pixelId: string | null;
}): MetaPurchaseEvent | null {
  if (!input.conversionsEnabled || !input.pixelId || !input.facts.paid) return null;
  if (!Number.isFinite(input.facts.value) || input.facts.value <= 0) return null;
  return {
    pixelId: input.pixelId,
    value: input.facts.value,
    currency: input.facts.currency,
    transactionId: input.facts.transactionId,
  };
}

/** Plan name for the success page, from the verified tier only. */
export function paidPlanName(facts: CheckoutSessionFacts | null): 'Plus' | 'Max' | null {
  if (!facts?.paid) return null;
  if (facts.tier === 'plus') return 'Plus';
  if (facts.tier === 'family') return 'Max';
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function checkoutFactsFromJson(payload: unknown): CheckoutSessionFacts | null {
  if (!isRecord(payload)) return null;
  const transactionId = typeof payload.transactionId === 'string' ? payload.transactionId : null;
  const currency = typeof payload.currency === 'string' ? payload.currency : null;
  const value = typeof payload.value === 'number' ? payload.value : null;
  if (!transactionId || !SESSION_ID.test(transactionId) || !currency || value === null) {
    return null;
  }
  return {
    transactionId,
    value,
    currency,
    paid: payload.paid === true,
    tier: payload.tier === 'plus' || payload.tier === 'family' ? payload.tier : null,
  };
}

export async function fetchCheckoutSessionFacts(
  sessionId: string,
  appUrl: string = APP_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutSessionFacts | null> {
  const url = `${appUrl.replace(/\/$/, '')}/api/billing/checkout-session?session_id=${encodeURIComponent(sessionId)}`;
  try {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res.ok) return null;
    return checkoutFactsFromJson(await res.json());
  } catch {
    return null;
  }
}
