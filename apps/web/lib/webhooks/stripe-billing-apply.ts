import { type Database, schema } from '@hale/db';
import type { PlanTier } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import {
  stripeBillingRevokeEnabled,
  stripeRefundEndsSubscriptionEnabled,
} from '~/lib/billing/flags';
import { decidePaidSessionGrant } from '~/lib/billing/session-price-guard';
import {
  type RefundedCharge,
  type StripeChargeLookup,
  stripeChargeLookupFromEnv,
} from '~/lib/billing/stripe-charge-context';
import { db as defaultDb } from '~/lib/db';
import { alertDisallowedCheckoutPrice } from '~/lib/monitoring/billing-disallowed-price';
import { alertUnresolvedBillingRevoke } from '~/lib/monitoring/billing-tier-alert';
import type { FailurePageDeps } from '~/lib/monitoring/failure-page';
import type { OpsPageOutcome } from '~/lib/monitoring/ops-slack';
import {
  type PlanHoldReason,
  type PlanRetry,
  type PlanSignal,
  claimEvent,
  eventAlreadyClaimed,
  planReaderFor,
  retryFromFailure,
  settleFamilyPlan,
  writeHeldRow,
} from './settle-family-plan.js';
import {
  type ChargeRevokeDecision,
  LIVE_SUBSCRIPTION,
  type PaidTier,
  type PriceTierMap,
  type StripeTierOptions,
  chargeLinkFromStripeEvent,
  chargeRevokeDecision,
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
 * `retry` (the route answers 503: Stripe has not given a final answer, nothing is claimed)
 * and a thrown DB error (a genuine transient failure), which the route lets 500 so Stripe
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
  | { status: 'blocked' }
  | {
      status: 'kept';
      reason:
        | 'partial_refund'
        | 'active_subscription'
        | 'plan_unchanged'
        | 'older_invoice'
        | 'not_entitled';
    }
  | {
      status: 'unresolved';
      reason: 'no_family' | 'dispute_needs_review' | PlanHoldReason;
      opsAlert: OpsPageOutcome;
    }
  | PlanRetry;

type UnresolvedRevokeReason = 'no_family' | 'subscription_unresolved' | 'dispute_needs_review';

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
  /**
   * Charge → subscription lookup. Omitted uses STRIPE_SECRET_KEY when set.
   * Null skips the network (tests that already expanded the payload).
   */
  chargeLookup?: StripeChargeLookup | null;
  /** Test seam for the unresolved #ops page. */
  onUnresolvedRevoke?: (info: {
    eventId: string;
    reason: UnresolvedRevokeReason;
  }) => Promise<OpsPageOutcome | undefined>;
  /** The Stripe transport for the flag-on reads and the cancel. */
  stripeFetch?: typeof fetch;
  /** Test seam for the page when a plan is held. */
  onPlanUnsettled?: (info: {
    eventId: string;
    reason: string;
  }) => Promise<OpsPageOutcome | undefined>;
  /** Test seam for the refused-Stripe and refund-pending pages. */
  pageDeps?: FailurePageDeps;
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
    return markRefundReady(event, eventId, priceDecision, database, priceTierMap, deps);
  }
  if (stripeBillingRevokeEnabled(env)) {
    const revoke = chargeRevokeDecision(event);
    if (revoke.action !== 'ignore') {
      if (stripeRefundEndsSubscriptionEnabled(env) && isFullRefund(revoke)) {
        return settleRefund(event, eventId, database, priceTierMap, deps);
      }
      if (stripeRefundEndsSubscriptionEnabled(env) && revoke.kind === 'dispute') {
        return settleDispute(event, eventId, database, deps);
      }
      return applyChargeRevoke(event, eventId, revoke, database, deps);
    }
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
  if (stripeBillingRevokeEnabled(env) && stripeRefundEndsSubscriptionEnabled(env)) {
    return settleFamilyPlan(
      familyId,
      lifecycleSignal(event, eventId, refs, tier === 'free' ? null : tier),
      database,
      priceTierMap,
      deps,
    );
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

function isFullRefund(decision: Exclude<ChargeRevokeDecision, { action: 'ignore' }>): boolean {
  return (
    decision.kind === 'refund' &&
    !(decision.action === 'keep' && decision.reason === 'partial_refund')
  );
}

function eventCreatedSeconds(event: unknown): number | null {
  if (typeof event !== 'object' || event === null) return null;
  const created = (event as { created?: unknown }).created;
  return typeof created === 'number' ? created : null;
}

function lifecycleSignal(
  event: unknown,
  eventId: string,
  refs: { customerId: string | null; subscriptionId: string | null },
  eventTier: PaidTier | null,
): PlanSignal {
  const type = (event as { type?: unknown }).type;
  return {
    kind: 'lifecycle',
    eventId,
    eventCreated: eventCreatedSeconds(event),
    customerId: refs.customerId,
    subscriptionId: refs.subscriptionId,
    eventTier,
    paidEvent: type !== 'customer.subscription.deleted',
  };
}

/** Links the charge through the pinned read. `done` is an outcome to return as it stands. */
async function readLinkedCharge(
  event: unknown,
  eventId: string,
  refund: boolean,
  database: Database,
  deps: ApplyStripeBillingDeps,
): Promise<{ done: ApplyStripeBillingResult } | { charge: RefundedCharge; familyId: string }> {
  if (await eventAlreadyClaimed(database, eventId)) return { done: { status: 'duplicate' } };
  const { chargeId } = chargeLinkFromStripeEvent(event);
  const knownFamily = await familyIdForLinkedCharge(
    {
      familyId: familyIdFromStripeEvent(event),
      customerId: stripeRefsFromStripeEvent(event).customerId,
    },
    database,
  );
  if (!chargeId) {
    return {
      done: knownFamily
        ? await unresolvedRevoke(
            eventId,
            refund ? 'subscription_unresolved' : 'dispute_needs_review',
            knownFamily,
            database,
            deps,
            true,
          )
        : await unresolvedRevoke(eventId, 'no_family', null, database, deps, true),
    };
  }
  let charge: RefundedCharge;
  try {
    charge = await planReaderFor(deps).refundedCharge(chargeId);
  } catch (err) {
    const retry = await retryFromFailure(
      err,
      {
        eventId,
        familyId: knownFamily,
        eventCreated: eventCreatedSeconds(event),
        refund,
        subscriptionId: null,
        periodEnd: null,
      },
      database,
      deps,
    );
    if (retry) return { done: retry };
    throw err;
  }
  const familyId =
    knownFamily ??
    (await familyIdForLinkedCharge(
      { familyId: charge.familyId, customerId: charge.customerId },
      database,
    ));
  if (!familyId) {
    return { done: await unresolvedRevoke(eventId, 'no_family', null, database, deps, true) };
  }
  return { charge, familyId };
}

async function settleRefund(
  event: unknown,
  eventId: string,
  database: Database,
  priceTierMap: PriceTierMap,
  deps: ApplyStripeBillingDeps,
): Promise<ApplyStripeBillingResult> {
  const read = await readLinkedCharge(event, eventId, true, database, deps);
  if ('done' in read) return read.done;
  const { charge, familyId } = read;
  if (!charge.subscriptionId || !charge.invoice) {
    return unresolvedRevoke(eventId, 'subscription_unresolved', familyId, database, deps, true);
  }
  return settleFamilyPlan(
    familyId,
    {
      kind: 'refund',
      eventId,
      eventCreated: eventCreatedSeconds(event),
      customerId: charge.customerId,
      subscriptionId: charge.subscriptionId,
      invoice: charge.invoice,
      chargeId: charge.chargeId,
      chargeAmountCaptured: charge.amountCaptured,
    },
    database,
    priceTierMap,
    deps,
  );
}

/**
 * A dispute never changes the plan and never cancels: a person decides. Stripe can still
 * name a family Hale has erased, and audit_log's foreign key would refuse that row.
 */
async function settleDispute(
  event: unknown,
  eventId: string,
  database: Database,
  deps: ApplyStripeBillingDeps,
): Promise<ApplyStripeBillingResult> {
  const read = await readLinkedCharge(event, eventId, false, database, deps);
  if ('done' in read) return read.done;
  const [family] = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.id, read.familyId))
    .limit(1);
  return family
    ? unresolvedRevoke(eventId, 'dispute_needs_review', family.id, database, deps, true)
    : unresolvedRevoke(eventId, 'no_family', null, database, deps, true);
}

interface LinkedCharge {
  familyId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
}

async function applyChargeRevoke(
  event: unknown,
  eventId: string,
  decision: Exclude<ChargeRevokeDecision, { action: 'ignore' }>,
  database: Database,
  deps: ApplyStripeBillingDeps,
): Promise<ApplyStripeBillingResult> {
  const linked = await linkCharge(event, deps);
  const familyId = await familyIdForLinkedCharge(linked, database);
  const claimUnresolved = isFullRefund(decision);
  if (!familyId) {
    return unresolvedRevoke(eventId, 'no_family', null, database, deps, claimUnresolved);
  }

  type ChargeTxResult =
    | Exclude<ApplyStripeBillingResult, { status: 'unresolved' }>
    | { status: 'leave_unresolved' };

  return database
    .transaction(async (tx): Promise<ChargeTxResult> => {
      const existing = await tx
        .select({
          planTier: schema.families.planTier,
          stripeSubscriptionId: schema.families.stripeSubscriptionId,
        })
        .from(schema.families)
        .where(eq(schema.families.id, familyId))
        .limit(1);
      if (existing.length === 0) {
        console.warn(
          `stripe billing: event ${eventId} references unknown family ${familyId} — acknowledged, not applied`,
        );
        return { status: 'unknown_family' };
      }
      const current = existing[0];
      if (!current) return { status: 'unknown_family' };

      const partial = decision.action === 'keep' && decision.reason === 'partial_refund';
      const live =
        linked.subscriptionStatus !== null && LIVE_SUBSCRIPTION.has(linked.subscriptionStatus);
      const otherSubscription = Boolean(
        linked.subscriptionId &&
          current.stripeSubscriptionId &&
          linked.subscriptionId !== current.stripeSubscriptionId,
      );
      const tiedToCurrent =
        linked.subscriptionId !== null &&
        current.stripeSubscriptionId !== null &&
        linked.subscriptionId === current.stripeSubscriptionId;
      const nothingLiveOnFile = !current.stripeSubscriptionId;

      if (partial || live || otherSubscription) {
        const reason = partial ? 'partial_refund' : 'active_subscription';
        const claimed = await claimEvent(tx, eventId);
        if (!claimed) return { status: 'duplicate' };
        await tx.insert(schema.auditLog).values({
          familyId,
          actor: 'system',
          actionTaken: 'billing_refunded',
          targetTable: 'families',
          targetId: familyId,
          after: {
            planTier: current.planTier,
            source: 'stripe',
            stripeEventId: eventId,
            reason,
            tierChanged: false,
          },
        });
        return { status: 'kept', reason };
      }

      if (!tiedToCurrent && !nothingLiveOnFile) {
        return { status: 'leave_unresolved' };
      }

      const claimed = await claimEvent(tx, eventId);
      if (!claimed) return { status: 'duplicate' };
      await tx
        .update(schema.families)
        .set({ planTier: 'free', updatedAt: new Date() })
        .where(eq(schema.families.id, familyId));
      await tx.insert(schema.auditLog).values({
        familyId,
        actor: 'system',
        actionTaken: 'family_plan_updated',
        targetTable: 'families',
        targetId: familyId,
        before: { planTier: current.planTier },
        after: {
          planTier: 'free',
          source: 'stripe',
          stripeEventId: eventId,
          reason: decision.kind,
        },
      });
      return { status: 'applied', tier: 'free' };
    })
    .then(async (result): Promise<ApplyStripeBillingResult> => {
      if (result.status === 'leave_unresolved') {
        return unresolvedRevoke(
          eventId,
          'subscription_unresolved',
          familyId,
          database,
          deps,
          claimUnresolved,
        );
      }
      return result;
    });
}

async function linkCharge(event: unknown, deps: ApplyStripeBillingDeps): Promise<LinkedCharge> {
  const link = chargeLinkFromStripeEvent(event);
  const base: LinkedCharge = {
    familyId: familyIdFromStripeEvent(event),
    customerId: stripeRefsFromStripeEvent(event).customerId,
    subscriptionId: link.subscriptionId,
    subscriptionStatus: link.subscriptionStatus,
  };
  const needsLookup = !base.subscriptionId || (!base.familyId && !base.customerId);
  if (!needsLookup || !link.chargeId) return base;
  const lookup =
    deps.chargeLookup === undefined
      ? stripeChargeLookupFromEnv(deps.env ?? process.env)
      : deps.chargeLookup;
  if (!lookup) return base;
  const found = await lookup.lookupCharge(link.chargeId);
  return {
    familyId: base.familyId ?? found.familyId,
    customerId: base.customerId ?? found.customerId,
    subscriptionId: base.subscriptionId ?? found.subscriptionId,
    subscriptionStatus: base.subscriptionStatus ?? found.subscriptionStatus,
  };
}

async function familyIdForLinkedCharge(
  linked: Pick<LinkedCharge, 'familyId' | 'customerId'>,
  database: Database,
): Promise<string | null> {
  if (linked.familyId) return linked.familyId;
  if (!linked.customerId) return null;
  const rows = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.stripeCustomerId, linked.customerId))
    .limit(1);
  return rows[0]?.id ?? null;
}

async function unresolvedAlreadyRecorded(
  database: Pick<Database, 'select'>,
  familyId: string,
  eventId: string,
): Promise<boolean> {
  const rows = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'billing_revoke_unresolved'),
      ),
    )
    .limit(20);
  return rows.some((row) => auditEventId(row.after) === eventId);
}

async function unresolvedRevoke(
  eventId: string,
  reason: UnresolvedRevokeReason,
  familyId: string | null,
  database: Database,
  deps: ApplyStripeBillingDeps,
  claim: boolean,
): Promise<ApplyStripeBillingResult> {
  const row = (id: string) => ({
    familyId: id,
    actor: 'system',
    actionTaken: 'billing_revoke_unresolved',
    targetTable: 'families',
    targetId: id,
    after: { source: 'stripe', stripeEventId: eventId, reason, tierChanged: false },
  });
  if (claim) {
    const claimed = await database.transaction(async (tx) => {
      if (!(await claimEvent(tx, eventId))) return false;
      if (!familyId) return true;
      if (await unresolvedAlreadyRecorded(tx, familyId, eventId)) return false;
      await tx.insert(schema.auditLog).values(row(familyId));
      return true;
    });
    if (!claimed) return { status: 'duplicate' };
  } else {
    if (familyId && (await unresolvedAlreadyRecorded(database, familyId, eventId))) {
      return { status: 'duplicate' };
    }
    if (familyId) await database.insert(schema.auditLog).values(row(familyId));
  }
  const alert = deps.onUnresolvedRevoke ?? alertUnresolvedBillingRevoke;
  const posted = await alert({ eventId, reason });
  const opsAlert = posted ?? 'sent';
  console.warn('stripe billing: revoke unresolved', { eventId, reason, opsAlert });
  return { status: 'unresolved', reason, opsAlert };
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
  priceTierMap: PriceTierMap,
  deps: ApplyStripeBillingDeps,
): Promise<ApplyStripeBillingResult> {
  const familyId = familyIdFromStripeEvent(event);
  const refs = stripeRefsFromStripeEvent(event);
  const env = deps.env ?? process.env;
  const settlesPlan = stripeBillingRevokeEnabled(env) && stripeRefundEndsSubscriptionEnabled(env);
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
    // Moves the row version, so a settle already past its read cannot grant this subscription.
    if (settlesPlan) {
      await tx
        .update(schema.families)
        .set({ updatedAt: new Date() })
        .where(eq(schema.families.id, familyId));
    }
    return true;
  });
  if (!claimed) {
    // A crash right after the marker is corrected here, on the redelivery.
    if (settlesPlan && familyId) {
      await resettleAfterMarker(event, eventId, familyId, refs, database, priceTierMap, deps);
    }
    return { status: 'duplicate' };
  }
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
  if (settlesPlan && familyId) {
    await resettleAfterMarker(event, eventId, familyId, refs, database, priceTierMap, deps);
  }
  return { status: 'refund_ready', opsAlert };
}

async function resettleAfterMarker(
  event: unknown,
  eventId: string,
  familyId: string,
  refs: { customerId: string | null; subscriptionId: string | null },
  database: Database,
  priceTierMap: PriceTierMap,
  deps: ApplyStripeBillingDeps,
): Promise<void> {
  const claimKey = `${eventId}:refund_ready`;
  const settled = await settleFamilyPlan(
    familyId,
    lifecycleSignal(event, claimKey, refs, null),
    database,
    priceTierMap,
    deps,
  );
  if (settled.status === 'retry') {
    await writeHeldRow(
      familyId,
      claimKey,
      'resettle_failed',
      { subscriptionId: refs.subscriptionId, periodEnd: null, clearsOn: 'decision' },
      database,
      deps,
    );
  }
}

function auditSubscriptionId(after: unknown): string | null {
  if (typeof after !== 'object' || after === null || Array.isArray(after)) return null;
  const id = (after as { subscriptionId?: unknown }).subscriptionId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function auditEventId(after: unknown): string | null {
  if (typeof after !== 'object' || after === null || Array.isArray(after)) return null;
  const id = (after as { stripeEventId?: unknown }).stripeEventId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
