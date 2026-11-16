import { type Database, schema } from '@hale/db';
import type { PlanTier } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { decidePaidSessionGrant } from '~/lib/billing/session-price-guard';
import { db as defaultDb } from '~/lib/db';
import { alertDisallowedCheckoutPrice } from '~/lib/monitoring/billing-disallowed-price';
import type { OpsPageOutcome } from '~/lib/monitoring/ops-slack';
import {
  type PriceTierMap,
  type StripeTierOptions,
  eventIdFromStripeEvent,
  familyIdFromStripeEvent,
  paidEventOccurredAt,
  paymentLinkTierOptionsFromEnv,
  planTierFromStripeEvent,
  priceTierMapFromEnv,
  stripeRefsFromStripeEvent,
} from './stripe-billing.js';

/**
 * Applies a VERIFIED Stripe billing event to the family's plan_tier. Called only
 * after the route's signature gate returns `verified` — this never authenticates.
 *
 * Exactly-once by construction: the event id is claimed in stripe_billing_events
 * inside the SAME transaction as the plan_tier write + audit row, so a redelivered
 * event (Stripe retries every non-2xx) conflicts on the unique index and applies
 * nothing a second time. An event that maps to no tier (unrelated type / unknown
 * price) or carries no family reference writes nothing — an unknown price must
 * never silently grant a tier (rule #1), and an unattributable event has no family
 * to write. Every applied transition writes an immutable audit_log row (rule #6).
 *
 * Every outcome is TERMINAL — the caller returns 200 so Stripe stops retrying — EXCEPT
 * a thrown DB error (a genuine transient failure), which the route lets 500 so Stripe
 * retries. `unknown_family` (the event names a family that isn't in our DB) is terminal
 * too: the ledger still claims the event, we log, and we acknowledge rather than loop.
 * `refund_ready` is terminal as well: a paid session used a disallowed price (list
 * during the founding window, or a Payment Link with no founding price). Plan is not
 * granted; an audit marker is left; #ops is posted; nothing is auto-refunded. The
 * Slack outcome is named on the result (`opsAlert`) so a skip is never counted as
 * delivered (rule #11). `blocked` is terminal too: a later event for a subscription
 * already marked refund-ready does not grant and does not page #ops a second time.
 */
export type ApplyStripeBillingResult =
  | { status: 'applied'; tier: PlanTier }
  | { status: 'duplicate' }
  | { status: 'no_tier' }
  | { status: 'unbound' }
  | { status: 'unknown_family' }
  | { status: 'ignored' }
  | { status: 'refund_ready'; opsAlert: OpsPageOutcome }
  | { status: 'blocked' };

export interface ApplyStripeBillingDeps {
  now?: Date;
  env?: Record<string, string | undefined>;
  onDisallowedPrice?: (info: {
    eventId: string;
    sessionId: string | null;
    priceIds: readonly string[];
    reason: string;
  }) => Promise<OpsPageOutcome | undefined>;
  /** Test seam. Production queries billing_refund_ready audit rows. */
  subscriptionBlocked?: (familyId: string, subscriptionId: string) => Promise<boolean>;
}

export async function applyStripeBillingEvent(
  event: unknown,
  database: Database = defaultDb(),
  priceTierMap: PriceTierMap = priceTierMapFromEnv(),
  tierOptions: StripeTierOptions = paymentLinkTierOptionsFromEnv(),
  deps: ApplyStripeBillingDeps = {},
): Promise<ApplyStripeBillingResult> {
  const eventId = eventIdFromStripeEvent(event);
  if (!eventId) {
    return { status: 'ignored' };
  }
  const now = paidEventOccurredAt(event, deps.now ?? new Date());
  const env = deps.env ?? process.env;
  const priceDecision = decidePaidSessionGrant(event, now, env);
  if (priceDecision.status === 'disallowed') {
    return markRefundReady(event, eventId, priceDecision, database, deps);
  }
  const tier = planTierFromStripeEvent(event, priceTierMap, tierOptions);
  if (tier === null) {
    return { status: 'no_tier' };
  }
  const familyId = familyIdFromStripeEvent(event);
  if (!familyId) {
    return { status: 'unbound' };
  }

  const refs = stripeRefsFromStripeEvent(event);
  if (
    refs.subscriptionId &&
    (await isSubscriptionBlocked(database, familyId, refs.subscriptionId, deps))
  ) {
    return claimBlockedGrant(eventId, familyId, refs.subscriptionId, database);
  }

  return database.transaction(async (tx) => {
    const claim = await tx
      .insert(schema.stripeBillingEvents)
      .values({ eventId })
      .onConflictDoNothing()
      .returning({ id: schema.stripeBillingEvents.id });
    if (claim.length === 0) {
      return { status: 'duplicate' };
    }

    const existing = await tx
      .select({ planTier: schema.families.planTier })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1);

    const patch: {
      planTier: PlanTier;
      updatedAt: Date;
      stripeCustomerId?: string;
      stripeSubscriptionId?: string;
    } = { planTier: tier, updatedAt: new Date() };
    if (refs.customerId) patch.stripeCustomerId = refs.customerId;
    if (refs.subscriptionId) patch.stripeSubscriptionId = refs.subscriptionId;

    const updated = await tx
      .update(schema.families)
      .set(patch)
      .where(eq(schema.families.id, familyId))
      .returning({ id: schema.families.id });
    if (updated.length === 0) {
      // The event references a family we don't have (deleted, or a forged-but-signed
      // metadata). Terminal: the ledger already claimed the event id, so we log and
      // acknowledge rather than let Stripe retry forever. No plan write, no audit.
      console.warn(
        `stripe billing: event ${eventId} references unknown family ${familyId} — acknowledged, not applied`,
      );
      return { status: 'unknown_family' };
    }

    await tx.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'family_plan_updated',
      targetTable: 'families',
      targetId: familyId,
      before: { planTier: existing[0]?.planTier ?? null },
      after: { planTier: tier, source: 'stripe', stripeEventId: eventId },
    });

    return { status: 'applied', tier };
  });
}

async function isSubscriptionBlocked(
  database: Database,
  familyId: string,
  subscriptionId: string,
  deps: ApplyStripeBillingDeps,
): Promise<boolean> {
  if (deps.subscriptionBlocked) {
    return deps.subscriptionBlocked(familyId, subscriptionId);
  }
  const rows = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'billing_refund_ready'),
      ),
    )
    .limit(50);
  return rows.some((row) => auditSubscriptionId(row.after) === subscriptionId);
}

async function claimBlockedGrant(
  eventId: string,
  familyId: string,
  subscriptionId: string,
  database: Database,
): Promise<ApplyStripeBillingResult> {
  return database.transaction(async (tx) => {
    const claim = await tx
      .insert(schema.stripeBillingEvents)
      .values({ eventId })
      .onConflictDoNothing()
      .returning({ id: schema.stripeBillingEvents.id });
    if (claim.length === 0) {
      return { status: 'duplicate' };
    }
    const existing = await tx
      .select({ planTier: schema.families.planTier })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1);
    if (existing.length === 0) {
      return { status: 'blocked' };
    }
    await tx.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'billing_grant_blocked',
      targetTable: 'families',
      targetId: familyId,
      after: {
        stripeEventId: eventId,
        subscriptionId,
        prior: 'billing_refund_ready',
      },
    });
    return { status: 'blocked' };
  });
}

async function markRefundReady(
  event: unknown,
  eventId: string,
  decision: {
    priceIds: string[];
    reason: string;
    sessionId: string | null;
  },
  database: Database,
  deps: ApplyStripeBillingDeps,
): Promise<ApplyStripeBillingResult> {
  const familyId = familyIdFromStripeEvent(event);
  const refs = stripeRefsFromStripeEvent(event);
  const claimed = await database.transaction(async (tx) => {
    const claim = await tx
      .insert(schema.stripeBillingEvents)
      .values({ eventId })
      .onConflictDoNothing()
      .returning({ id: schema.stripeBillingEvents.id });
    if (claim.length === 0) return false;
    if (!familyId) return true;
    const existing = await tx
      .select({ planTier: schema.families.planTier })
      .from(schema.families)
      .where(eq(schema.families.id, familyId))
      .limit(1);
    if (existing.length === 0) return true;
    await tx.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'billing_refund_ready',
      targetTable: 'families',
      targetId: familyId,
      after: {
        stripeEventId: eventId,
        sessionId: decision.sessionId,
        subscriptionId: refs.subscriptionId,
        priceIds: decision.priceIds,
        reason: decision.reason,
        refund: 'ready',
        autoRefund: false,
      },
    });
    return true;
  });
  if (!claimed) return { status: 'duplicate' };
  const alert = deps.onDisallowedPrice ?? alertDisallowedCheckoutPrice;
  const posted = await alert({
    eventId,
    sessionId: decision.sessionId,
    priceIds: decision.priceIds,
    reason: decision.reason,
  });
  const opsAlert = posted ?? 'sent';
  console.warn('stripe billing: refund-ready ops alert', {
    eventId,
    sessionId: decision.sessionId,
    opsAlert,
  });
  return { status: 'refund_ready', opsAlert };
}

function auditSubscriptionId(after: unknown): string | null {
  if (typeof after !== 'object' || after === null || Array.isArray(after)) return null;
  const id = (after as { subscriptionId?: unknown }).subscriptionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
