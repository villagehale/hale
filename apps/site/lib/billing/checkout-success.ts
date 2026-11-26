import type { GooglePurchaseEvent } from '~/lib/analytics/google-purchase';
import { parseMetaPixelIds } from '~/lib/analytics/meta-pixel';
import type { MetaPurchaseEvent } from '~/lib/analytics/meta-purchase';
import { APP_URL } from '~/lib/app-url';

export { metaPixelIdFromEnv, metaPixelIdsFromEnv } from '~/lib/analytics/meta-pixel';

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

/** The page picks its state from hale-web's `view`. Set on both Vercel projects. */
export function checkoutSuccessStatesEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.CHECKOUT_SUCCESS_STATES_ENABLED === 'true';
}

/**
 * The check-in sentence is a promise only the billing-notice lane keeps. Set on both
 * Vercel projects together; the sentence also needs `checkInDue` from hale-web.
 */
export function billingThreadNoticesEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.BILLING_THREAD_NOTICES_ENABLED === 'true';
}

/** State H: Stripe's cancel_url brought this visitor back to the pricing page. */
export function checkoutWasCancelled(
  search: Record<string, string | string[] | undefined>,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return checkoutSuccessStatesEnabled(env) && search.checkout === 'cancelled';
}

export function googleAdsConversionSendTo(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const sendTo = env.NEXT_PUBLIC_GOOGLE_ADS_CONVERSION_SEND_TO?.trim();
  return sendTo ? sendTo : null;
}

export type PaidPlanName = 'Plus' | 'Max';

/**
 * The page state hale-web chose from Stripe and its DB. The plan name always comes from
 * the verified tier.
 */
export type CheckoutSuccessView =
  | {
      readonly state: 'plan_active';
      readonly plan: PaidPlanName;
      readonly checkInDue: boolean;
    }
  | { readonly state: 'upgraded' }
  | { readonly state: 'already_on_plan'; readonly plan: PaidPlanName }
  | { readonly state: 'new_visitor' }
  | { readonly state: 'pending' }
  | { readonly state: 'under_review' }
  | { readonly state: 'receipt' }
  | { readonly state: 'not_paid' }
  | { readonly state: 'unknown' };

export interface CheckoutSessionFacts {
  readonly transactionId: string;
  readonly value: number;
  readonly currency: string;
  readonly paid: boolean;
  /** Verified paid tier from the app's Stripe retrieve. `family` is Max. */
  readonly tier: 'plus' | 'family' | null;
  /** Present only when hale-web has CHECKOUT_SUCCESS_STATES_ENABLED on. */
  readonly view?: CheckoutSuccessView;
  /** A paid /pricing checkout. Present only when the app says so. */
  readonly direct?: true;
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
  const pixelIds = parseMetaPixelIds(input.pixelId);
  if (!input.conversionsEnabled || pixelIds.length === 0 || !input.facts.paid) return null;
  if (!Number.isFinite(input.facts.value) || input.facts.value <= 0) return null;
  return {
    pixelId: pixelIds.join(','),
    value: input.facts.value,
    currency: input.facts.currency,
    transactionId: input.facts.transactionId,
  };
}

function planNameForTier(tier: CheckoutSessionFacts['tier']): PaidPlanName | null {
  if (tier === 'plus') return 'Plus';
  if (tier === 'family') return 'Max';
  return null;
}

/** Plan name for the success page, from the verified tier only. */
export function paidPlanName(facts: CheckoutSessionFacts | null): PaidPlanName | null {
  if (!facts?.paid) return null;
  return planNameForTier(facts.tier);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PLAIN_VIEW_STATES = [
  'upgraded',
  'new_visitor',
  'pending',
  'under_review',
  'receipt',
  'not_paid',
  'unknown',
] as const;

function isPlainViewState(value: unknown): value is (typeof PLAIN_VIEW_STATES)[number] {
  return (PLAIN_VIEW_STATES as readonly unknown[]).includes(value);
}

/** A whitelist: an unknown state is no view, and an unknown field never passes through. */
function checkoutViewFromJson(
  payload: unknown,
  tier: CheckoutSessionFacts['tier'],
): CheckoutSuccessView | null {
  if (!isRecord(payload)) return null;
  const { state } = payload;
  if (state === 'plan_active' || state === 'already_on_plan') {
    const plan = planNameForTier(tier);
    if (!plan) return { state: 'receipt' };
    if (state === 'already_on_plan') return { state, plan };
    return { state, plan, checkInDue: payload.checkInDue === true };
  }
  return isPlainViewState(state) ? { state } : null;
}

export function checkoutFactsFromJson(payload: unknown): CheckoutSessionFacts | null {
  if (!isRecord(payload)) return null;
  const transactionId = typeof payload.transactionId === 'string' ? payload.transactionId : null;
  const currency = typeof payload.currency === 'string' ? payload.currency : null;
  const value = typeof payload.value === 'number' ? payload.value : null;
  if (!transactionId || !SESSION_ID.test(transactionId) || !currency || value === null) {
    return null;
  }
  const tier = payload.tier === 'plus' || payload.tier === 'family' ? payload.tier : null;
  const view = checkoutViewFromJson(payload.view, tier);
  return {
    transactionId,
    value,
    currency,
    paid: payload.paid === true,
    tier,
    ...(view ? { view } : {}),
    ...(payload.direct === true ? { direct: true as const } : {}),
  };
}

/**
 * The state this page renders. Null renders today's page: the flag is off here, or
 * hale-web sent no view. With no id or a failed read nobody knows whether a charge went
 * through, so the answer is `unknown`, the one view that makes no claim about money.
 */
export function checkoutViewForPage(
  sessionId: string | null,
  facts: CheckoutSessionFacts | null,
  env: Record<string, string | undefined> = process.env,
): CheckoutSuccessView | null {
  if (!checkoutSuccessStatesEnabled(env)) return null;
  if (!sessionId || !facts) return { state: 'unknown' };
  return facts.view ?? null;
}

/**
 * Preview hale-web sits behind Vercel SSO. A server fetch from this site is not a
 * browser, so without the automation bypass it comes back 302 and the success page
 * cannot read the session. Production has no such secret, so the header stays off.
 */
export function vercelProtectionBypassHeaders(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const bypass = env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (!bypass) return {};
  return { 'x-vercel-protection-bypass': bypass };
}

export async function fetchCheckoutSessionFacts(
  sessionId: string,
  appUrl: string = APP_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<CheckoutSessionFacts | null> {
  const url = `${appUrl.replace(/\/$/, '')}/api/billing/checkout-session?session_id=${encodeURIComponent(sessionId)}`;
  const bypass = vercelProtectionBypassHeaders();
  try {
    const res = await fetchImpl(url, {
      cache: 'no-store',
      ...(Object.keys(bypass).length > 0 ? { headers: bypass } : {}),
    });
    if (!res.ok) return null;
    return checkoutFactsFromJson(await res.json());
  } catch {
    return null;
  }
}
