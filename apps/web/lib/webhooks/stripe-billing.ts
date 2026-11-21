import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BillingPeriod, PlanTier } from '@hale/types';
import {
  familyPriceIdsFromEnv,
  foundingWindowOpen,
  plusPriceIdsFromEnv,
  promoMaxPriceIdsFromEnv,
} from '~/lib/billing/prices';
import type { OtherSubscriptions, PeriodStanding } from '~/lib/billing/stripe-charge-context';

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
 *   checkout.session.completed        → metadata.tier, else the configured Payment Link tier
 *   invoice.paid                      → metadata.tier, else the invoice line's price
 *   customer.subscription.updated     → tier of the active price after the change
 *   customer.subscription.deleted     → 'free' (subscription ended → downgrade)
 *   charge.refunded (full)            → 'free' once the charge is tied to a subscription
 *                                       that has ended and nothing else is paid
 *   charge.dispute.created            → the same; a dispute never cancels anything
 *   (any other event type)            → null (not a tier-affecting event)
 *
 * Refund and dispute revocation runs only when STRIPE_BILLING_REVOKE_ENABLED
 * is exactly `true`. Verification still requires STRIPE_WEBHOOK_SECRET and
 * does not wait on that flag. With STRIPE_REFUND_ENDS_SUBSCRIPTION_ENABLED also
 * exactly `true`, a full refund of the charge that paid a live subscription's
 * current period ends that subscription in Stripe and then drops the plan:
 * {@link refundOutcome} and {@link disputeOutcome} hold the whole decision.
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

/**
 * Payment Link fallback for checkout.session.completed.
 *
 * A Dashboard Payment Link does not carry the per-family metadata a Checkout
 * Session does. When the event's `payment_link` equals `paymentLinkId` and
 * metadata.tier is absent, grant `paymentLinkTier`. Both must be set — an
 * unset id never grants.
 */
export interface StripeTierOptions {
  paymentLinkId?: string | null;
  paymentLinkTier?: PaidTier | null;
  /** False during the founding window — never grant Plus from an old Payment Link. */
  allowPaymentLink?: boolean;
}

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
function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
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
  // Promo Plus yearly and Plus USD list ids grant plus. Max promo yearly
  // grants family. invoice.paid after the cutoff still maps those prices —
  // we never migrate a locked promo subscription to list.
  for (const priceId of plusPriceIdsFromEnv(env)) {
    if (!(priceId in map)) map[priceId] = 'plus';
  }
  for (const priceId of promoMaxPriceIdsFromEnv(env)) {
    if (!(priceId in map)) map[priceId] = 'family';
  }
  for (const priceId of familyPriceIdsFromEnv(env)) {
    if (!(priceId in map)) map[priceId] = 'family';
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
 * family to, or null when the event does not affect billing tier. Follows Stripe's
 * canonical subscription lifecycle, against the REAL webhook shapes (verified
 * against stripe-node types):
 *
 *   - subscription.created/updated → tier of the active price (items.data[0].price.id);
 *     .created is the primary activation. An unknown price returns null — never a
 *     silent grant (rule #1).
 *   - subscription.deleted → 'free' (downgrade).
 *   - checkout.session.completed → tier from OUR metadata.tier. Stripe does NOT send
 *     line_items/price on the webhook session object (they exist only when expanded,
 *     which webhooks never are), so we read the tier we ourselves set at session
 *     creation. A missing / non-paid metadata.tier returns null.
 *
 * Returns null (never throws) for anything else.
 */
export function paymentLinkTierOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): StripeTierOptions {
  const tier = env.STRIPE_PAYMENT_LINK_TIER?.trim();
  return {
    paymentLinkId: env.STRIPE_PAYMENT_LINK_ID?.trim() || null,
    paymentLinkTier: tier === 'plus' || tier === 'family' ? tier : null,
    allowPaymentLink: !foundingWindowOpen(now, env),
  };
}

export function planTierFromStripeEvent(
  payload: unknown,
  priceTierMap: PriceTierMap,
  options: StripeTierOptions = {},
): PlanTier | null {
  if (!isRecord(payload)) return null;
  const type = readString(payload.type);
  const object = isRecord(payload.data) ? payload.data.object : undefined;
  if (!isRecord(object)) return null;

  switch (type) {
    case 'customer.subscription.deleted':
      return 'free';
    case 'customer.subscription.created':
    case 'customer.subscription.updated': {
      const priceId = subscriptionPriceId(object);
      if (!priceId) return null;
      return priceTierMap[priceId] ?? null;
    }
    case 'checkout.session.completed': {
      const metadata = isRecord(object.metadata) ? object.metadata : null;
      const tier = paidTierToken(metadata ? readString(metadata.tier) : null);
      if (tier) return tier;
      const priceId = metadata ? readString(metadata.priceId) : null;
      if (priceId && priceTierMap[priceId]) return priceTierMap[priceId] ?? null;
      return paymentLinkTierFrom(object, options);
    }
    case 'invoice.paid': {
      const metadata = isRecord(object.metadata) ? object.metadata : null;
      const tier = paidTierToken(metadata ? readString(metadata.tier) : null);
      if (tier) return tier;
      const priceId = invoicePriceId(object);
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
  const metadataFamilyId = isRecord(object.metadata) ? readString(object.metadata.familyId) : null;
  return (
    metadataFamilyId ??
    readString(object.client_reference_id) ??
    subscriptionDetailsFamilyId(object) ??
    invoiceLineFamilyId(object)
  );
}

/** Customer and subscription ids carried on a billing event, when Stripe sent them. */
export function stripeRefsFromStripeEvent(payload: unknown): {
  customerId: string | null;
  subscriptionId: string | null;
} {
  if (!isRecord(payload)) return { customerId: null, subscriptionId: null };
  const object = isRecord(payload.data) ? payload.data.object : undefined;
  if (!isRecord(object)) return { customerId: null, subscriptionId: null };
  const details = subscriptionDetails(object);
  return {
    customerId: readId(object.customer),
    subscriptionId:
      readId(object.subscription) ??
      (details ? readId(details.subscription) : null) ??
      // customer.subscription.* objects are the subscription: their id is the sub id.
      (object.items !== undefined ? readId(object.id) : null),
  };
}

/**
 * When Stripe says this paid event happened. `created` is unix seconds on the
 * event envelope. A late delivery after the founding cutoff must not reopen a
 * list-price grant that was paid during the window — receipt time is the
 * wrong clock. Missing / non-numeric `created` falls back to `fallback`.
 */
export function paidEventOccurredAt(payload: unknown, fallback: Date = new Date()): Date {
  if (!isRecord(payload)) return fallback;
  const created = payload.created;
  if (typeof created === 'number' && Number.isFinite(created) && created > 0) {
    return new Date(created * 1000);
  }
  return fallback;
}

/** The Stripe event id (`evt_…`) — the natural idempotency key. Null if malformed. */
export function eventIdFromStripeEvent(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return readString(payload.id);
}

/** Grant the configured Payment Link tier only when the event names that link. */
function paymentLinkTierFrom(
  object: Record<string, unknown>,
  options: StripeTierOptions,
): PaidTier | null {
  if (options.allowPaymentLink === false) return null;
  if (!options.paymentLinkId || !options.paymentLinkTier) return null;
  if (!isPaidTier(options.paymentLinkTier)) return null;
  if (readString(object.payment_link) !== options.paymentLinkId) return null;
  return options.paymentLinkTier;
}

/** Newest invoice line price, either the legacy price object or the 2025 price_details. */
function invoicePriceId(object: Record<string, unknown>): string | null {
  const lines = isRecord(object.lines) ? object.lines.data : undefined;
  if (!Array.isArray(lines) || !isRecord(lines[0])) return null;
  const line = lines[0];
  if (isRecord(line.price)) {
    const id = readString(line.price.id);
    if (id) return id;
  }
  const pricing = isRecord(line.pricing) ? line.pricing.price_details : undefined;
  if (isRecord(pricing)) return readString(pricing.price);
  return null;
}

function invoiceLineFamilyId(object: Record<string, unknown>): string | null {
  const lines = isRecord(object.lines) ? object.lines.data : undefined;
  if (!Array.isArray(lines)) return null;
  for (const line of lines) {
    if (!isRecord(line) || !isRecord(line.metadata)) continue;
    const familyId = readString(line.metadata.familyId);
    if (familyId) return familyId;
  }
  return null;
}

/** Subscription metadata lives on parent.subscription_details in current API versions. */
function subscriptionDetails(object: Record<string, unknown>): Record<string, unknown> | null {
  const parent = isRecord(object.parent) ? object.parent : null;
  if (parent && isRecord(parent.subscription_details)) return parent.subscription_details;
  if (isRecord(object.subscription_details)) return object.subscription_details;
  return null;
}

function subscriptionDetailsFamilyId(object: Record<string, unknown>): string | null {
  const details = subscriptionDetails(object);
  if (!details || !isRecord(details.metadata)) return null;
  return readString(details.metadata.familyId);
}

function readId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (isRecord(value)) return readString(value.id);
  return null;
}

/** The active price id on a subscription object (items.data[0].price.id), or null. */
function subscriptionPriceId(object: Record<string, unknown>): string | null {
  const items = isRecord(object.items) ? object.items.data : undefined;
  if (Array.isArray(items) && isRecord(items[0]) && isRecord(items[0].price)) {
    return readString(items[0].price.id);
  }
  return null;
}

/** Type guard: a string is one of the purchasable paid tiers. */
function isPaidTier(value: string): value is PaidTier {
  return (PAID_TIERS as readonly string[]).includes(value);
}

/**
 * `plus` → plus. `family` and `max` → family. Case-insensitive, so a Max
 * checkout recorded as `Max` grants Max limits instead of leaving the family
 * on Free. Anything else is null (never a silent Plus grant).
 */
export function paidTierToken(value: string | null): PaidTier | null {
  if (!value) return null;
  const token = value.trim().toLowerCase();
  if (token === 'plus') return 'plus';
  if (token === 'family' || token === 'max') return 'family';
  return null;
}

export const LIVE_SUBSCRIPTION: ReadonlySet<string> = new Set(['active', 'trialing', 'past_due']);

/** Terminal in Stripe. `unpaid` and `paused` are not here: both can come back. */
export const ENDED_SUBSCRIPTION: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

/** Stripe documents search as up to an hour behind during an outage. */
export const SEARCH_SETTLE_SECONDS = 3600;

export type ChargeRevokeDecision =
  | { action: 'ignore' }
  | { action: 'revoke'; kind: 'refund' | 'dispute' }
  | {
      action: 'keep';
      reason: 'partial_refund' | 'active_subscription';
      kind: 'refund' | 'dispute';
    };

/**
 * Candidate only. A partial refund keeps the tier. A full refund or a dispute
 * is a revoke candidate. {@link refundOutcome} and {@link disputeOutcome} make
 * the decision once the charge is tied to a subscription.
 */
export function chargeRevokeDecision(payload: unknown): ChargeRevokeDecision {
  if (!isRecord(payload)) return { action: 'ignore' };
  const type = readString(payload.type);
  const object = isRecord(payload.data) ? payload.data.object : undefined;
  if (!isRecord(object) || !type) return { action: 'ignore' };

  if (type === 'charge.refunded') {
    if (!isFullRefund(object)) return { action: 'keep', reason: 'partial_refund', kind: 'refund' };
    if (liveSubscriptionRemains(object)) {
      return { action: 'keep', reason: 'active_subscription', kind: 'refund' };
    }
    return { action: 'revoke', kind: 'refund' };
  }

  if (
    type === 'charge.dispute.created' ||
    type === 'charge.dispute.funds_withdrawn' ||
    (type === 'charge.dispute.closed' && readString(object.status)?.toLowerCase() === 'lost')
  ) {
    if (liveSubscriptionRemains(object)) {
      return { action: 'keep', reason: 'active_subscription', kind: 'dispute' };
    }
    return { action: 'revoke', kind: 'dispute' };
  }

  return { action: 'ignore' };
}

export type RevokeKeepReason =
  | 'partial_refund'
  | 'active_subscription'
  | 'subscription_not_ended'
  | 'older_invoice'
  | 'duplicate_subscription'
  | 'already_free';

export type RevokeUnresolvedReason =
  | 'subscription_unresolved'
  | 'current_period_unproven'
  | 'surviving_plan_differs'
  | 'dispute_plan_kept';

/**
 * `holdGrants`: the refunded subscription keeps its place in Stripe but stops granting a tier
 * until a renewal takes new money ({@link renewalPaidAfter}).
 */
export type RevokeOutcome =
  | { action: 'keep'; reason: RevokeKeepReason; holdGrants?: true }
  | { action: 'drop'; cancelSubscriptionIds: readonly string[] }
  | { action: 'unresolved'; reason: RevokeUnresolvedReason; holdGrants?: true }
  | { action: 'wait' }
  /** This row depends on the family's other subscriptions: call again with `other`. */
  | { action: 'needs_scan' };

/** What the charge proved, read from Stripe as it is now and from the family row. */
export interface RevokeFacts {
  flagOn: boolean;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  subscriptionCreated: number | null;
  namesAnotherFamily: boolean;
  periodStanding: PeriodStanding | null;
  planTier: PlanTier;
  /** A hint only. It never proves that this charge paid that subscription. */
  storedSubscriptionId: string | null;
  /** The wall clock: an event's own `created` never advances across redeliveries. */
  nowSeconds: number;
  other: OtherSubscriptions | null;
  priceTierMap: PriceTierMap;
}

const keep = (reason: RevokeKeepReason): RevokeOutcome => ({ action: 'keep', reason });

const unresolved = (reason: RevokeUnresolvedReason): RevokeOutcome => ({
  action: 'unresolved',
  reason,
});

/** A null `created` counts as settled: only an already-expanded payload has none. */
export function withinSearchSettle(created: number | null, nowSeconds: number): boolean {
  return created !== null && nowSeconds - created < SEARCH_SETTLE_SECONDS;
}

function settling(facts: RevokeFacts): boolean {
  return withinSearchSettle(facts.subscriptionCreated, facts.nowSeconds);
}

function storedNamesAnother(facts: RevokeFacts): boolean {
  return facts.storedSubscriptionId !== null && facts.storedSubscriptionId !== facts.subscriptionId;
}

/** The one tier the remaining subscriptions sell, or null when that cannot be said. */
export function soleSurvivingTier(
  other: OtherSubscriptions,
  priceTierMap: PriceTierMap,
): PlanTier | null {
  if (other.truncated) return null;
  const tiers = new Set(
    other.paid.map((row) => (row.priceId ? (priceTierMap[row.priceId] ?? null) : null)),
  );
  const [tier] = tiers;
  return tiers.size === 1 && tier ? tier : null;
}

/**
 * A refunded duplicate never moves the plan, and it stops granting one: while it stays in
 * Stripe its next update would write its own tier for money that was refunded. When the plan
 * on file is not what the remaining subscription sells, a person decides.
 */
function keepSurvivingPlan(
  facts: RevokeFacts,
  other: OtherSubscriptions,
  reason: RevokeKeepReason,
): RevokeOutcome {
  if (!facts.flagOn) return keep(reason);
  const matches =
    facts.planTier === 'free' || soleSurvivingTier(other, facts.priceTierMap) === facts.planTier;
  return matches
    ? { action: 'keep', reason, holdGrants: true }
    : { action: 'unresolved', reason: 'surviving_plan_differs', holdGrants: true };
}

/**
 * The one event that lifts a hold: a renewal that took money and was invoiced after the
 * refunded invoice. A subscription update proves no payment, and a late copy of the refunded
 * invoice's own `invoice.paid` is not newer than itself.
 */
export function renewalPaidAfter(payload: unknown, liftsOnRenewalAfter: number | null): boolean {
  if (liftsOnRenewalAfter === null || !isRecord(payload) || payload.type !== 'invoice.paid') {
    return false;
  }
  const object = isRecord(payload.data) ? payload.data.object : undefined;
  if (!isRecord(object)) return false;
  return (
    object.billing_reason === 'subscription_cycle' &&
    typeof object.amount_paid === 'number' &&
    object.amount_paid > 0 &&
    typeof object.created === 'number' &&
    object.created > liftsOnRenewalAfter
  );
}

/**
 * The refund decision. With the flag off it never asks to cancel anything, and it drops a
 * family only when the charge is proven to have paid a subscription that has ended and
 * nothing else is paid.
 */
export function refundOutcome(facts: RevokeFacts & { partial: boolean }): RevokeOutcome {
  if (facts.partial) return keep('partial_refund');
  const { subscriptionId, subscriptionStatus: status } = facts;
  if (subscriptionId === null || status === null || facts.namesAnotherFamily) {
    return unresolved('subscription_unresolved');
  }

  if (ENDED_SUBSCRIPTION.has(status)) {
    if (facts.planTier === 'free') return keep('already_free');
    const { other } = facts;
    if (other === null) return { action: 'needs_scan' };
    // Nothing may be cancelled with the flag off, so a refunded sibling still bills.
    const refundedCountsAsPaid = !facts.flagOn && other.refundedIds.length > 0;
    if (other.paid.length > 0 || other.truncated || refundedCountsAsPaid) {
      return keepSurvivingPlan(facts, other, 'active_subscription');
    }
    if (!facts.flagOn && storedNamesAnother(facts)) return unresolved('subscription_unresolved');
    if (settling(facts)) return { action: 'wait' };
    return { action: 'drop', cancelSubscriptionIds: other.refundedIds };
  }

  if (!facts.flagOn) {
    return keep(LIVE_SUBSCRIPTION.has(status) ? 'active_subscription' : 'subscription_not_ended');
  }
  const period = facts.periodStanding ?? 'unproven';
  if (period === 'older') return keep('older_invoice');
  // The charge paid S's latest invoice, so S may not grant while a person looks at it.
  if (period === 'unproven') {
    return { action: 'unresolved', reason: 'current_period_unproven', holdGrants: true };
  }
  const { other } = facts;
  if (other === null) return { action: 'needs_scan' };
  if (other.paid.length > 0 || other.truncated) {
    return keepSurvivingPlan(facts, other, 'duplicate_subscription');
  }
  if (settling(facts)) return { action: 'wait' };
  return { action: 'drop', cancelSubscriptionIds: [subscriptionId, ...other.refundedIds] };
}

/**
 * The dispute decision. A bank-initiated dispute is not a refund, so it never cancels and
 * never reads as one: a family with a subscription that has not ended keeps the plan and
 * #ops decides.
 */
export function disputeOutcome(facts: RevokeFacts): RevokeOutcome {
  const noneCancelled: RevokeOutcome = { action: 'drop', cancelSubscriptionIds: [] };
  const paidElsewhere = (other: OtherSubscriptions) =>
    other.paid.length > 0 || other.refundedIds.length > 0 || other.truncated;

  if (facts.namesAnotherFamily) return unresolved('subscription_unresolved');
  if (facts.subscriptionId === null || facts.subscriptionStatus === null) {
    if (facts.storedSubscriptionId !== null) return unresolved('subscription_unresolved');
    if (facts.other === null) return { action: 'needs_scan' };
    return paidElsewhere(facts.other) ? unresolved('dispute_plan_kept') : noneCancelled;
  }
  if (!ENDED_SUBSCRIPTION.has(facts.subscriptionStatus)) return unresolved('dispute_plan_kept');
  if (facts.other === null) return { action: 'needs_scan' };
  if (paidElsewhere(facts.other)) return unresolved('dispute_plan_kept');
  if (storedNamesAnother(facts)) return unresolved('subscription_unresolved');
  if (settling(facts)) return { action: 'wait' };
  return noneCancelled;
}

/** `created` on a subscription event's object, in unix seconds. */
export function subscriptionCreatedFromStripeEvent(payload: unknown): number | null {
  if (!isRecord(payload) || !isRecord(payload.data) || !isRecord(payload.data.object)) return null;
  const created = payload.data.object.created;
  return typeof created === 'number' ? created : null;
}

/** Subscription id on a charge or dispute, when Stripe expanded it. */
export function chargeSubscriptionId(payload: unknown): string | null {
  return chargeLinkFromStripeEvent(payload).subscriptionId;
}

/**
 * What a charge or dispute payload itself proves. `chargeId` is present on
 * both shapes (the charge's id, or the dispute's `charge`). Subscription id
 * and status are set only when Stripe expanded them — an invoice id string
 * does not identify a subscription.
 */
export function chargeLinkFromStripeEvent(payload: unknown): {
  chargeId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
} {
  if (!isRecord(payload)) return { chargeId: null, subscriptionId: null, subscriptionStatus: null };
  const type = readString(payload.type);
  const object = isRecord(payload.data) ? payload.data.object : undefined;
  if (!isRecord(object)) return { chargeId: null, subscriptionId: null, subscriptionStatus: null };
  const nested = nestedSubscription(object);
  const chargeId =
    type?.startsWith('charge.dispute.') === true ? readId(object.charge) : readString(object.id);
  return {
    chargeId,
    subscriptionId: nested.id,
    subscriptionStatus: nested.status,
  };
}

function isFullRefund(object: Record<string, unknown>): boolean {
  if (object.refunded === true) return true;
  const amount = typeof object.amount === 'number' ? object.amount : null;
  const refundedAmount = typeof object.amount_refunded === 'number' ? object.amount_refunded : null;
  return amount !== null && refundedAmount !== null && amount > 0 && refundedAmount >= amount;
}

function liveSubscriptionRemains(object: Record<string, unknown>): boolean {
  const status = nestedSubscription(object).status;
  return status !== null && LIVE_SUBSCRIPTION.has(status);
}

function nestedSubscription(object: Record<string, unknown>): {
  id: string | null;
  status: string | null;
} {
  const direct = subscriptionRef(object.subscription);
  if (direct.id || direct.status) return direct;
  const invoice = isRecord(object.invoice) ? object.invoice : null;
  if (invoice) return subscriptionRef(invoice.subscription);
  return { id: null, status: null };
}

function subscriptionRef(value: unknown): { id: string | null; status: string | null } {
  if (typeof value === 'string' && value.length > 0) return { id: value, status: null };
  if (!isRecord(value)) return { id: null, status: null };
  const status = readString(value.status)?.toLowerCase() ?? null;
  return { id: readString(value.id), status };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
