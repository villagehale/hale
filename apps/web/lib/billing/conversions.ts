import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import { type Attribution, type BillingCurrency, checkoutPersonId } from '@hale/types';
import { PROMO_PRICE_DISPLAY } from '@hale/types';
import {
  type CheckoutCaptureOutcome,
  captureCheckoutEvent,
} from '~/lib/analytics/checkout-capture';
import {
  type FunnelOutcome,
  type FunnelSender,
  captureFunnelEvent,
  posthogFunnelSender,
} from '~/lib/analytics/funnel';
import { funnelAttributionEnabled } from '~/lib/analytics/funnel-flag';
import { metaPixelIdFromEnv } from '~/lib/analytics/meta-pixel';
import { captureServerEvent, hashFamilyId } from '~/lib/analytics/server-capture';
import { eventIdFromStripeEvent, familyIdFromStripeEvent } from '~/lib/webhooks/stripe-billing';
import { type AdsCheckoutContext, adsContextFromStripeMetadata } from './ads-context.js';
import { attributionFromStripeMetadata } from './attribution.js';
import { metaCapiEnabled } from './flags.js';
import { CHECKOUT_SKU_PERIOD, type CheckoutSku } from './prices.js';
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
 * A family purchase is reported only after applyStripeBillingEvent returns `applied`,
 * which has already claimed the Stripe event id. An unbound /pricing checkout is
 * reported by deliverUnboundCheckoutPurchase, which claims the event id and
 * `purchase:<session id>` itself. Both claims live in stripe_billing_events.
 * That path stays dark until FUNNEL_ATTRIBUTION_ENABLED is exactly true, including
 * Meta, so a deploy does not start a new Purchase while the flag is off.
 * No child data. Email and phone are hashed per Meta's spec and never sent to PostHog.
 */

export type ConversionSkipReason =
  | 'flag_off'
  | 'not_configured'
  | 'not_a_purchase'
  | 'provider_error'
  | 'preview'
  | 'duplicate';

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
  readonly tier: 'plus' | 'family' | null;
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
    tier: paidTier(metadata?.tier),
  };
}

function paidTier(value: unknown): 'plus' | 'family' | null {
  const token = readString(value)?.toLowerCase();
  if (token === 'plus') return 'plus';
  if (token === 'family' || token === 'max') return 'family';
  return null;
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
    tier,
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
  funnel: FunnelOutcome | 'no_family';
}

function isCheckoutSku(value: string | null): value is CheckoutSku {
  return value !== null && Object.hasOwn(CHECKOUT_SKU_PERIOD, value);
}

/**
 * checkout_completed: the funnel's paid step, read from the session metadata the
 * checkout wrote (tier, sku, attribution). Never the Stripe customer's contact details.
 */
async function sendFunnelCheckoutCompleted(
  purchase: PurchaseConversion,
  payload: unknown,
  env: Record<string, string | undefined>,
  sender: FunnelSender,
): Promise<FunnelOutcome | 'no_family'> {
  if (!purchase.familyId) return 'no_family';
  const object = isRecord(payload) && isRecord(payload.data) ? payload.data.object : undefined;
  const metadata = isRecord(object) && isRecord(object.metadata) ? object.metadata : null;
  const plan = metadata ? readString(metadata.tier) : null;
  const period = isCheckoutSku(purchase.sku) ? CHECKOUT_SKU_PERIOD[purchase.sku] : null;
  return captureFunnelEvent(
    {
      event: 'checkout_completed',
      familyId: purchase.familyId,
      attribution: purchase.attribution,
      properties: { ...(plan ? { plan } : {}), ...(period ? { period } : {}) },
      ...(plan ? { set: { plan } } : {}),
    },
    { sender, env },
  );
}

export async function reportBillingPurchase(
  payload: unknown,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  funnel: FunnelSender = posthogFunnelSender,
): Promise<PurchaseConversionReport | { status: 'skipped'; reason: 'not_a_purchase' }> {
  const purchase = purchaseFromStripeEvent(payload);
  if (!purchase) {
    return { status: 'skipped', reason: 'not_a_purchase' };
  }
  const [meta, posthog, funnelOutcome] = await Promise.all([
    sendMetaPurchase(purchase, env, fetchImpl),
    sendPosthogPurchase(purchase),
    sendFunnelCheckoutCompleted(purchase, payload, env, funnel),
  ]);
  return { meta, posthog, funnel: funnelOutcome };
}

const unboundFunnelSender: FunnelSender = {
  send: (capture) =>
    captureCheckoutEvent(capture.event, capture.distinctId, capture.properties, {
      ...(capture.set ? { set: capture.set } : {}),
      ...(capture.setOnce ? { setOnce: capture.setOnce } : {}),
    }),
};

export type UnboundPurchaseCapture = (
  event: 'purchase',
  distinctId: string,
  properties: Record<string, unknown>,
) => Promise<CheckoutCaptureOutcome>;

/**
 * Paid checkout.session.completed with no family. PostHog distinct id is
 * `cs:` plus the session id. Properties are sku, value, currency, tier, and
 * attribution — never phone or email. Meta event_id is the session id, so a
 * browser Purchase with the same eventID dedupes. The Stripe event id and
 * `purchase:<session id>` are claimed together; a retry or a second event for
 * the same session does not send again. Dark until FUNNEL_ATTRIBUTION_ENABLED,
 * and that includes Meta, so the claim is not written while the flag is off.
 * A claim that throws propagates (the route answers 500 and Stripe retries).
 * A send that throws is caught here: the claim already landed, so a retry
 * must not send a second Purchase.
 */
export async function deliverUnboundCheckoutPurchase(
  database: Database,
  payload: unknown,
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch,
  funnel: FunnelSender = unboundFunnelSender,
  capture: UnboundPurchaseCapture = captureCheckoutEvent,
): Promise<PurchaseConversionReport | { status: 'skipped'; reason: ConversionSkipReason }> {
  if (!funnelAttributionEnabled(env)) {
    return { status: 'skipped', reason: 'flag_off' };
  }
  const purchase = purchaseFromStripeEvent(payload);
  const person = purchase ? checkoutPersonId(purchase.eventId) : null;
  if (!purchase || purchase.familyId || !person) {
    return { status: 'skipped', reason: 'not_a_purchase' };
  }
  const eventId = eventIdFromStripeEvent(payload);
  if (!eventId || !isClaimKey(eventId)) {
    return { status: 'skipped', reason: 'not_a_purchase' };
  }
  const claimed = await claimUnboundPurchase(database, eventId, purchase.eventId);
  if (!claimed) return { status: 'skipped', reason: 'duplicate' };
  try {
    const [meta, posthog, funnelOutcome] = await Promise.all([
      sendMetaPurchase(purchase, env, fetchImpl),
      sendUnboundPosthogPurchase(purchase, person, capture),
      sendUnboundFunnelCheckoutCompleted(purchase, person, env, funnel),
    ]);
    return { meta, posthog, funnel: funnelOutcome };
  } catch (err) {
    console.warn('billing conversions: unbound report failed', {
      err: err instanceof Error ? err.name : 'unknown',
    });
    return {
      meta: { status: 'skipped', reason: 'provider_error' },
      posthog: { status: 'skipped', reason: 'provider_error' },
      funnel: 'provider_error',
    };
  }
}

function isClaimKey(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !/[\s@]/.test(value);
}

async function claimUnboundPurchase(
  database: Database,
  eventId: string,
  sessionId: string,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    const eventInserted = await tx
      .insert(schema.stripeBillingEvents)
      .values({ eventId })
      .onConflictDoNothing()
      .returning({ id: schema.stripeBillingEvents.id });
    if (eventInserted.length === 0) return false;
    const sessionInserted = await tx
      .insert(schema.stripeBillingEvents)
      .values({ eventId: `purchase:${sessionId}` })
      .onConflictDoNothing()
      .returning({ id: schema.stripeBillingEvents.id });
    return sessionInserted.length > 0;
  });
}

async function sendUnboundPosthogPurchase(
  purchase: PurchaseConversion,
  distinctId: string,
  capture: UnboundPurchaseCapture,
): Promise<ConversionSendResult> {
  const properties: Record<string, unknown> = {
    currency: purchase.currency,
    value: purchase.value,
    ...purchase.attribution,
  };
  if (purchase.sku) properties.sku = purchase.sku;
  if (purchase.tier) properties.tier = purchase.tier;
  try {
    const outcome = await capture('purchase', distinctId, properties);
    if (outcome === 'not_configured') return { status: 'skipped', reason: 'not_configured' };
    if (outcome === 'provider_error') return { status: 'skipped', reason: 'provider_error' };
    return { status: 'sent' };
  } catch {
    return { status: 'skipped', reason: 'provider_error' };
  }
}

async function sendUnboundFunnelCheckoutCompleted(
  purchase: PurchaseConversion,
  distinctId: string,
  env: Record<string, string | undefined>,
  sender: FunnelSender,
): Promise<FunnelOutcome> {
  return captureFunnelEvent(
    {
      event: 'checkout_completed',
      distinctId,
      attribution: purchase.attribution,
      properties: {
        currency: purchase.currency,
        value: purchase.value,
        ...(purchase.sku ? { sku: purchase.sku } : {}),
        ...(purchase.tier ? { tier: purchase.tier } : {}),
      },
    },
    { sender, env },
  );
}
