import { createHash } from 'node:crypto';
import type { Attribution, BillingCurrency } from '@hale/types';
import { PROMO_PRICE_DISPLAY } from '@hale/types';
import { metaPixelIdFromEnv } from '~/lib/analytics/meta-pixel';
import { captureServerEvent, hashFamilyId } from '~/lib/analytics/server-capture';
import { familyIdFromStripeEvent } from '~/lib/webhooks/stripe-billing';
import { type AdsCheckoutContext, adsContextFromStripeMetadata } from './ads-context.js';
import { attributionFromStripeMetadata } from './attribution.js';
import { metaCapiEnabled } from './flags.js';
import { isPromoPreviewFamily } from './promo-preview.js';

/**
 * Server-side Purchase conversions from a verified Stripe billing webhook.
 *
 * Meta CAPI is the Purchase source of truth. event_id is the Stripe Checkout
 * Session id so a browser Pixel Purchase with the same eventID dedupes.
 * The post goes to the first id in NEXT_PUBLIC_META_PIXEL_ID only. A later
 * dataset has no CAPI access token yet and receives the browser pixel only.
 * Google Ads Purchase fires in the browser on the checkout success page.
 *
 * Each sender no-ops with a named reason when its flag or env is missing (rule #11).
 * Idempotency is the Stripe event id: the route only calls this after
 * applyStripeBillingEvent returns `applied`, so a redelivery does not send again.
 * No child data. Email and phone are hashed per Meta's spec and never sent to PostHog.
 */

export type ConversionSkipReason =
  | 'flag_off'
  | 'not_configured'
  | 'not_a_purchase'
  | 'provider_error'
  | 'preview';

export type ConversionSendResult =
  | { status: 'sent' }
  | { status: 'skipped'; reason: ConversionSkipReason };

export interface PurchaseConversion {
  readonly eventId: string;
  readonly orderId: string;
  readonly value: number;
  readonly currency: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly familyId: string | null;
  readonly attribution: Attribution;
  readonly ads: AdsCheckoutContext;
  readonly sku: string | null;
}

const META_GRAPH = 'https://graph.facebook.com/v21.0';

export const META_CAPI_TEST_EVENT_CODE_ENV = 'META_CAPI_TEST_EVENT_CODE';

/** Events Manager Test Events code. Unset outside a test window. */
export function metaTestEventCodeFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const code = env[META_CAPI_TEST_EVENT_CODE_ENV]?.trim();
  return code ? code : null;
}

export interface MetaCapiPurchaseBody {
  readonly data: readonly Record<string, unknown>[];
  readonly test_event_code?: string;
}

export function metaCapiPurchaseBody(
  purchase: PurchaseConversion,
  env: Record<string, string | undefined> = process.env,
): MetaCapiPurchaseBody {
  const userData: Record<string, unknown> = {};
  if (purchase.email) userData.em = [hashEmailForAds(purchase.email)];
  if (purchase.phone) {
    const hashed = hashPhoneForAds(purchase.phone);
    if (hashed) userData.ph = [hashed];
  }
  if (purchase.ads.fbp) userData.fbp = purchase.ads.fbp;
  if (purchase.ads.fbc) userData.fbc = purchase.ads.fbc;
  if (purchase.ads.clientIp) userData.client_ip_address = purchase.ads.clientIp;
  if (purchase.ads.clientUserAgent) userData.client_user_agent = purchase.ads.clientUserAgent;
  const body: MetaCapiPurchaseBody = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(Date.now() / 1000),
        event_id: purchase.eventId,
        action_source: 'website',
        user_data: userData,
        custom_data: {
          currency: purchase.currency,
          value: purchase.value,
          content_type: 'product',
          contents: purchase.sku ? [{ id: purchase.sku, quantity: 1 }] : undefined,
        },
      },
    ],
  };
  const testEventCode = metaTestEventCodeFromEnv(env);
  return testEventCode ? { ...body, test_event_code: testEventCode } : body;
}

export function eventsReceivedFromMetaJson(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  return readNumber(payload.events_received);
}

export function hashEmailForAds(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

/** SHA-256 of digits-only E.164 (leading country code, no plus). */
export function hashPhoneForAds(phone: string): string | null {
  let digits = phone.replace(/\D/g, '');
  if (digits.length === 10) digits = `1${digits}`;
  if (digits.length < 11) return null;
  return createHash('sha256').update(digits).digest('hex');
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
 * Only checkout.session.completed with a paid session is a Purchase.
 * invoice.paid on a renewal is a later charge, not an ads conversion.
 * eventId is the Checkout Session id (cs_…) so Meta can dedupe Pixel + CAPI.
 */
export function purchaseFromStripeEvent(payload: unknown): PurchaseConversion | null {
  if (!isRecord(payload)) return null;
  if (readString(payload.type) !== 'checkout.session.completed') return null;
  const object = isRecord(payload.data) ? payload.data.object : undefined;
  if (!isRecord(object)) return null;
  const sessionId = readString(object.id);
  if (!sessionId) return null;
  const paymentStatus = readString(object.payment_status);
  if (paymentStatus && paymentStatus !== 'paid' && paymentStatus !== 'no_payment_required') {
    return null;
  }
  const amountTotal = readNumber(object.amount_total);
  const currency = readString(object.currency)?.toUpperCase();
  if (amountTotal === null || !currency) return null;
  const details = isRecord(object.customer_details) ? object.customer_details : null;
  const email = (details ? readString(details.email) : null) ?? readString(object.customer_email);
  const phone = details ? readString(details.phone) : null;
  const metadata = isRecord(object.metadata) ? object.metadata : null;
  return {
    eventId: sessionId,
    orderId: sessionId,
    value: amountTotal / 100,
    currency,
    email,
    phone,
    familyId: familyIdFromStripeEvent(payload),
    attribution: attributionFromStripeMetadata(metadata),
    ads: adsContextFromStripeMetadata(metadata),
    sku: metadata ? readString(metadata.sku) : null,
  };
}

export async function sendMetaPurchase(
  purchase: PurchaseConversion,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<ConversionSendResult> {
  const preview = isPromoPreviewFamily(purchase.familyId, env);
  const testEventCode = metaTestEventCodeFromEnv(env);
  if (preview && !testEventCode) {
    console.info('billing conversions: meta skipped', { reason: 'preview' });
    return { status: 'skipped', reason: 'preview' };
  }
  if (!metaCapiEnabled(env) && !(preview && testEventCode)) {
    return { status: 'skipped', reason: 'flag_off' };
  }
  // First id only. A later dataset in the list has no CAPI token yet.
  const pixelId = metaPixelIdFromEnv(env);
  const token = env.META_CAPI_ACCESS_TOKEN?.trim();
  if (!pixelId || !token) {
    console.info('billing conversions: meta skipped', { reason: 'not_configured' });
    return { status: 'skipped', reason: 'not_configured' };
  }
  const posted = await postMetaCapiPurchase(purchase, pixelId, token, env, fetchImpl);
  if (posted.status === 'error') {
    return { status: 'skipped', reason: 'provider_error' };
  }
  return { status: 'sent' };
}

async function postMetaCapiPurchase(
  purchase: PurchaseConversion,
  pixelId: string,
  token: string,
  env: Record<string, string | undefined>,
  fetchImpl: typeof fetch,
): Promise<
  | { status: 'ok'; httpStatus: number; eventsReceived: number | null }
  | { status: 'error'; httpStatus: number | null }
> {
  try {
    const res = await fetchImpl(`${META_GRAPH}/${pixelId}/events?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(metaCapiPurchaseBody(purchase, env)),
    });
    if (!res.ok) {
      console.warn('billing conversions: meta provider_error', { status: res.status });
      return { status: 'error', httpStatus: res.status };
    }
    let eventsReceived: number | null = null;
    try {
      eventsReceived = eventsReceivedFromMetaJson(await res.json());
    } catch {
      eventsReceived = null;
    }
    return { status: 'ok', httpStatus: res.status, eventsReceived };
  } catch {
    console.warn('billing conversions: meta provider_error');
    return { status: 'error', httpStatus: null };
  }
}

export type MetaTestPurchaseTier = 'plus' | 'family';

export function metaTestPurchaseTierFromUnknown(value: unknown): MetaTestPurchaseTier {
  return value === 'family' || value === 'max' ? 'family' : 'plus';
}

export function metaTestPurchaseCurrencyFromUnknown(value: unknown): BillingCurrency {
  return value === 'USD' || value === 'usd' ? 'USD' : 'CAD';
}

/** Fake values hashed at send time. Never a real parent. Amounts match PROMO_PRICE_DISPLAY. */
export function metaTestPurchaseFor(
  tier: MetaTestPurchaseTier = 'plus',
  currency: BillingCurrency = 'CAD',
): PurchaseConversion {
  const display = PROMO_PRICE_DISPLAY[tier][currency];
  return {
    eventId: 'cs_test_ops',
    orderId: 'cs_test_ops',
    value: display.amount,
    currency,
    email: 'capi.test@example.com',
    phone: '+1 555 010 0100',
    familyId: null,
    attribution: {},
    ads: {},
    sku: tier === 'family' ? 'promo_max_annual' : 'promo_plus_annual',
  };
}

/** @deprecated Prefer metaTestPurchaseFor(tier, currency). Plus CAD $59. */
export const META_TEST_PURCHASE: PurchaseConversion = metaTestPurchaseFor('plus', 'CAD');

export type MetaTestPurchaseResult =
  | { status: number; events_received: number | null }
  | { status: 'skipped'; reason: 'not_configured' | 'provider_error' };

/**
 * Ops probe: one Test Events Purchase. Needs the first pixel id, token, and
 * META_CAPI_TEST_EVENT_CODE. A later dataset in NEXT_PUBLIC_META_PIXEL_ID has
 * no CAPI token yet, so this posts to the first id only. Does not consult
 * META_CAPI_ENABLED — lighting the live webhook is a separate step. Prints
 * nothing; the script prints status.
 */
export async function sendMetaTestPurchase(
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  choice: { tier?: unknown; currency?: unknown } = {},
): Promise<MetaTestPurchaseResult> {
  // Same first-id rule as the live webhook. The newer dataset has no token.
  const pixelId = metaPixelIdFromEnv(env);
  const token = env.META_CAPI_ACCESS_TOKEN?.trim();
  const testEventCode = metaTestEventCodeFromEnv(env);
  if (!pixelId || !token || !testEventCode) {
    return { status: 'skipped', reason: 'not_configured' };
  }
  const purchase = metaTestPurchaseFor(
    metaTestPurchaseTierFromUnknown(choice.tier),
    metaTestPurchaseCurrencyFromUnknown(choice.currency),
  );
  const posted = await postMetaCapiPurchase(purchase, pixelId, token, env, fetchImpl);
  if (posted.status === 'error') {
    return { status: 'skipped', reason: 'provider_error' };
  }
  return { status: posted.httpStatus, events_received: posted.eventsReceived };
}

export async function sendPosthogPurchase(
  purchase: PurchaseConversion,
): Promise<ConversionSendResult> {
  if (!purchase.familyId) {
    return { status: 'skipped', reason: 'not_a_purchase' };
  }
  const properties: Record<string, unknown> = {
    currency: purchase.currency,
    value: purchase.value,
    sku: purchase.sku ?? 'plus',
    ...purchase.attribution,
  };
  try {
    const outcome = await captureServerEvent(
      'purchase',
      hashFamilyId(purchase.familyId),
      properties,
      { setOnce: { ...purchase.attribution } },
    );
    if (outcome === 'not_configured') return { status: 'skipped', reason: 'not_configured' };
    if (outcome === 'provider_error') return { status: 'skipped', reason: 'provider_error' };
    return { status: 'sent' };
  } catch {
    return { status: 'skipped', reason: 'provider_error' };
  }
}

export interface PurchaseConversionReport {
  meta: ConversionSendResult;
  posthog: ConversionSendResult;
}

export async function reportBillingPurchase(
  payload: unknown,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<PurchaseConversionReport | { status: 'skipped'; reason: 'not_a_purchase' }> {
  const purchase = purchaseFromStripeEvent(payload);
  if (!purchase) {
    return { status: 'skipped', reason: 'not_a_purchase' };
  }
  const [meta, posthog] = await Promise.all([
    sendMetaPurchase(purchase, env, fetchImpl),
    sendPosthogPurchase(purchase),
  ]);
  return { meta, posthog };
}
