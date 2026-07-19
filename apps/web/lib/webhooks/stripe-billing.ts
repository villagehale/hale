import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BillingPeriod, PlanTier } from '@hale/types';

/**
 * Stripe billing webhook contract (B18).
 *
 * This module is the provider-agnostic billing layer: the security gate, the pure
 * event→tier mapping, and the env-boundary config. It is REAL but DORMANT — every
 * function short-circuits to `not_configured` / `null` / `false` until the Stripe
 * keys exist, so absent keys the whole surface is byte-identical to a no-op.
 *
 * Responsibilities, deliberately split so the pure parts stay I/O-free & testable:
 *   1. verifyStripeBillingSignature — the security gate. Implements Stripe's real
 *      `t=,v1=` HMAC-SHA256 scheme with a replay-tolerance window. Until
 *      STRIPE_WEBHOOK_SECRET exists it returns `not_configured` (route 501) — we
 *      NEVER act on an unverified billing event (a forged event could grant a paid
 *      tier for free).
 *   2. planTierFromStripeEvent / familyIdFromStripeEvent / eventIdFromStripeEvent —
 *      PURE extraction from a (verified) event: the tier transition it implies, the
 *      family it targets, and its idempotency key. No I/O, no env, no Stripe SDK.
 *   3. priceTierMapFromEnv / checkoutPriceIdFromEnv / isStripeCheckoutConfigured —
 *      env-boundary config. Price ids are injected (never baked inline) — they
 *      arrive as STRIPE_PRICE_{PLUS,FAMILY}_{MONTHLY,ANNUAL} env at go-live.
 *
 * ── Event → plan_tier mapping (the contract the live handler honours) ──
 *   checkout.session.completed        → tier of the purchased price (plus|family)
 *   customer.subscription.updated     → tier of the active price after the change
 *   customer.subscription.deleted     → 'free' (subscription ended → downgrade)
 *   (any other event type)            → null (not a tier-affecting event)
 *
 * ── Which family an event targets ──
 *   We thread the family id through Stripe metadata at checkout creation
 *   (client_reference_id on the session, metadata.familyId on the session AND the
 *   subscription), so every tier-affecting event carries it back — no
 *   stripe_customer_id ↔ family mapping table is needed.
 */

/** Maps a Stripe price id to the plan tier it sells. */
export type PriceTierMap = Readonly<Record<string, PlanTier>>;

/** The paid tiers a checkout can be created for (Free is never purchased). */
export type PaidTier = Exclude<PlanTier, 'free'>;

type VerifyResult =
  | { status: 'verified' }
  | { status: 'not_configured'; reason: string }
  | { status: 'invalid'; reason: string };

/** Stripe's default webhook replay-tolerance window (seconds). */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies a Stripe billing webhook signature using Stripe's documented scheme:
 * the `Stripe-Signature` header carries `t=<unix>,v1=<hex>[,v1=<hex>…]`; the signed
 * payload is `${t}.${rawBody}` and each `v1` is its HMAC-SHA256 (hex) under the
 * endpoint secret. A verified request must also fall inside the tolerance window
 * (replay defence). Absent STRIPE_WEBHOOK_SECRET it returns `not_configured` so the
 * route answers 501 — billing events are NEVER processed unverified.
 */
export function verifyStripeBillingSignature(
  signature: string | null,
  rawBody: string,
  secret: string | undefined = process.env.STRIPE_WEBHOOK_SECRET,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  if (!secret) {
    return {
      status: 'not_configured',
      reason: 'STRIPE_WEBHOOK_SECRET not provisioned — billing webhook not yet live',
    };
  }
  if (!signature) {
    return { status: 'invalid', reason: 'missing stripe-signature header' };
  }
  const parsed = parseSignatureHeader(signature);
  if (!parsed) {
    return { status: 'invalid', reason: 'malformed stripe-signature header' };
  }
  if (Math.abs(nowSeconds - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return { status: 'invalid', reason: 'timestamp outside tolerance (possible replay)' };
  }
  const expected = createHmac('sha256', secret)
    .update(`${parsed.timestamp}.${rawBody}`)
    .digest('hex');
  if (!parsed.signatures.some((candidate) => safeEqual(expected, candidate))) {
    return { status: 'invalid', reason: 'stripe signature mismatch' };
  }
  return { status: 'verified' };
}

/** Parses `t=…,v1=…[,v1=…]` into a timestamp + candidate signatures, or null. */
function parseSignatureHeader(
  header: string,
): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      const parsedT = Number.parseInt(value, 10);
      if (Number.isFinite(parsedT) && String(parsedT) === value) timestamp = parsedT;
    } else if (key === 'v1' && value.length > 0) {
      signatures.push(value);
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** Constant-time hex-string comparison (length-guarded before timingSafeEqual). */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** The env var for a tier+period's Stripe price id, e.g. STRIPE_PRICE_PLUS_ANNUAL. */
function priceEnvVar(tier: PaidTier, period: BillingPeriod): string {
  return `STRIPE_PRICE_${tier.toUpperCase()}_${period.toUpperCase()}`;
}

const PAID_TIERS: readonly PaidTier[] = ['plus', 'family'];
const BILLING_PERIODS: readonly BillingPeriod[] = ['monthly', 'annual'];

/**
 * Resolves the price→tier map from env at the route boundary — EVERY configured
 * price id (both periods of both paid tiers) maps to its tier, so a subscription
 * event referencing any of them resolves. Absent ids are simply omitted.
 */
export function priceTierMapFromEnv(
  env: Record<string, string | undefined> = process.env,
): PriceTierMap {
  const map: Record<string, PlanTier> = {};
  for (const tier of PAID_TIERS) {
    for (const period of BILLING_PERIODS) {
      const priceId = env[priceEnvVar(tier, period)];
      if (priceId) map[priceId] = tier;
    }
  }
  return map;
}

/** The Stripe price id to charge for a tier+period, or null when unconfigured. */
export function checkoutPriceIdFromEnv(
  tier: PaidTier,
  period: BillingPeriod,
  env: Record<string, string | undefined> = process.env,
): string | null {
  return env[priceEnvVar(tier, period)] ?? null;
}

/**
 * True iff Stripe Checkout can actually be created: the secret key plus every
 * tier+period price id are present. The plan-page Upgrade CTA is gated on this so
 * it only appears when a real checkout would succeed for any tier the user picks.
 */
export function isStripeCheckoutConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!env.STRIPE_SECRET_KEY) return false;
  return PAID_TIERS.every((tier) =>
    BILLING_PERIODS.every((period) => Boolean(env[priceEnvVar(tier, period)])),
  );
}

/**
 * Pure mapping from a Stripe event payload to the plan_tier it transitions the
 * family to, or null when the event does not affect billing tier.
 *
 * Returns null (rather than throwing) when a tier-affecting event references a
 * price not in the map — an unknown price must not silently grant a tier.
 */
export function planTierFromStripeEvent(
  payload: unknown,
  priceTierMap: PriceTierMap,
): PlanTier | null {
  if (!isRecord(payload)) return null;
  const type = readString(payload.type);
  const object = isRecord(payload.data) ? payload.data.object : undefined;
  if (!isRecord(object)) return null;

  switch (type) {
    case 'customer.subscription.deleted':
      return 'free';
    case 'checkout.session.completed':
    case 'customer.subscription.updated': {
      const priceId = extractPriceId(object);
      if (!priceId) return null;
      return priceTierMap[priceId] ?? null;
    }
    default:
      return null;
  }
}

/**
 * The family id a (verified) event targets — threaded through Stripe at checkout
 * creation as metadata.familyId (session + subscription) and client_reference_id
 * (session). Returns null when neither is present (the event is unattributable and
 * must not be applied).
 */
export function familyIdFromStripeEvent(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const object = isRecord(payload.data) ? payload.data.object : undefined;
  if (!isRecord(object)) return null;
  const metadataFamilyId = isRecord(object.metadata)
    ? readString(object.metadata.familyId)
    : null;
  return metadataFamilyId ?? readString(object.client_reference_id);
}

/** The Stripe event id (`evt_…`) — the natural idempotency key. Null if malformed. */
export function eventIdFromStripeEvent(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return readString(payload.id);
}

/**
 * Pulls the active price id from a subscription or checkout-session object.
 * Subscriptions carry it at items.data[0].price.id; checkout sessions reference
 * it via the line item / price.
 */
function extractPriceId(object: Record<string, unknown>): string | null {
  const items = isRecord(object.items) ? object.items.data : undefined;
  if (Array.isArray(items) && isRecord(items[0]) && isRecord(items[0].price)) {
    const id = readString(items[0].price.id);
    if (id) return id;
  }
  if (isRecord(object.price)) {
    const id = readString(object.price.id);
    if (id) return id;
  }
  return readString(object.price);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
