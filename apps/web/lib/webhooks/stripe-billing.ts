import type { PlanTier } from '@hale/types';

/**
 * Stripe billing webhook contract (B18).
 *
 * Stripe LIVE is BLOCKED — no keys yet. This module is the provider-agnostic
 * billing layer + the webhook contract; live wiring lands when keys arrive.
 *
 * Two responsibilities, deliberately split:
 *   1. verifyStripeBillingSignature — the security gate. Until
 *      STRIPE_WEBHOOK_SECRET exists it is a named TODO that refuses to process
 *      anything (the route returns 501). We NEVER act on an unverified billing
 *      event — a forged event could grant a paid tier for free.
 *   2. planTierFromStripeEvent — the PURE mapping from a (verified) event to the
 *      plan_tier transition it implies. Unit-tested with fixture payloads; no
 *      I/O, no env reads, no Stripe SDK.
 *
 * ── Event → plan_tier mapping (the contract the live handler will honour) ──
 *   checkout.session.completed        → tier of the purchased price (plus|family)
 *   customer.subscription.updated     → tier of the active price after the change
 *   customer.subscription.deleted     → 'free' (subscription ended → downgrade)
 *   (any other event type)            → null (not a tier-affecting event)
 *
 * The price-id → tier map is injected (not baked inline) because the live
 * Stripe price ids don't exist yet — they arrive as STRIPE_PRICE_PLUS /
 * STRIPE_PRICE_FAMILY env at go-live. `priceTierMapFromEnv` reads them at the
 * boundary; the pure mapper takes the resolved map so tests stay deterministic.
 */

/** Maps a Stripe price id to the plan tier it sells. */
export type PriceTierMap = Readonly<Record<string, PlanTier>>;

type VerifyResult =
  | { status: 'verified' }
  | { status: 'not_configured'; reason: string }
  | { status: 'invalid'; reason: string };

/**
 * Verifies a Stripe billing webhook signature.
 *
 * TODO(B18, live): implement Stripe's t=/v1= HMAC-SHA256 scheme once
 * STRIPE_WEBHOOK_SECRET is provisioned. Until then this returns 'not_configured'
 * so the route answers 501 — billing events are NEVER processed unverified.
 */
export function verifyStripeBillingSignature(
  signature: string | null,
  _rawBody: string,
  secret: string | undefined = process.env.STRIPE_WEBHOOK_SECRET,
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
  // TODO(B18, live): real HMAC verification of Stripe's signed payload.
  return {
    status: 'not_configured',
    reason: 'stripe signature verification not implemented (live wiring pending)',
  };
}

/** Resolves the price→tier map from env at the route boundary. */
export function priceTierMapFromEnv(
  env: Record<string, string | undefined> = process.env,
): PriceTierMap {
  const map: Record<string, PlanTier> = {};
  if (env.STRIPE_PRICE_PLUS) map[env.STRIPE_PRICE_PLUS] = 'plus';
  if (env.STRIPE_PRICE_FAMILY) map[env.STRIPE_PRICE_FAMILY] = 'family';
  return map;
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
