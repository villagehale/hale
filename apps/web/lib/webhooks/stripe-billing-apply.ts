import { type Database, schema } from '@hale/db';
import type { PlanTier } from '@hale/types';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  stripeBillingRevokeEnabled,
  stripeRefundEndsSubscriptionEnabled,
} from '~/lib/billing/flags';
import { stripeRefundApiFromEnv } from '~/lib/billing/refund-family';
import { decidePaidSessionGrant } from '~/lib/billing/session-price-guard';
import {
  type PeriodStanding,
  STRIPE_LOOKUP_TIMEOUT_MS,
  type StripeChargeLookup,
  StripeLookupError,
  stripeChargeLookupFromEnv,
} from '~/lib/billing/stripe-charge-context';
import { db as defaultDb } from '~/lib/db';
import { alertDisallowedCheckoutPrice } from '~/lib/monitoring/billing-disallowed-price';
import { alertUnresolvedBillingRevoke } from '~/lib/monitoring/billing-tier-alert';
import { type FailurePageDeps, type OpsPagerOutcome, pageOps } from '~/lib/monitoring/failure-page';
import type { OpsPageOutcome } from '~/lib/monitoring/ops-slack';
import {
  type ChargeRevokeDecision,
  ENDED_SUBSCRIPTION,
  type PriceTierMap,
  type RevokeFacts,
  type RevokeKeepReason,
  type RevokeUnresolvedReason,
  type StripeTierOptions,
  chargeLinkFromStripeEvent,
  chargeRevokeDecision,
  disputeOutcome,
  eventIdFromStripeEvent,
  familyIdFromStripeEvent,
  paidEventOccurredAt,
  paymentLinkTierOptionsFromEnv,
  planTierFromStripeEvent,
  priceTierMapFromEnv,
  refundOutcome,
  stripeRefsFromStripeEvent,
  subscriptionCreatedFromStripeEvent,
  withinSearchSettle,
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
 * `retry` and a thrown DB error (a genuine transient failure), which the route lets 500 so
 * Stripe retries. `retry` means a refund or dispute could not be decided yet: Stripe could
 * not be read or could not cancel, the search index may still hide a sibling, or the family
 * changed under the decision. Nothing is claimed, the route answers 503, and the redelivery
 * decides from fresh state, because a claimed refund can never be replayed.
 * `unknown_family` (the event names a family that isn't in our DB) is terminal
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
  | { status: 'kept'; reason: RevokeKeepReason | 'subscription_already_ended' }
  | {
      status: 'unresolved';
      reason: UnresolvedRevokeReason;
      opsAlert: OpsPageOutcome;
    }
  | RevokeRetry;

type UnresolvedRevokeReason = 'no_family' | RevokeUnresolvedReason;

interface RevokeRetry {
  status: 'retry';
  reason:
    | 'stripe_unavailable'
    | 'stripe_refused'
    | 'stripe_not_configured'
    | 'stripe_cancel_failed'
    | 'search_settling'
    | 'family_changed';
  opsAlert?: OpsPagerOutcome;
}

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
   * Null means no client: a charge that needs a lookup is `retry`, never a guess.
   */
  chargeLookup?: StripeChargeLookup | null;
  /** The one Stripe transport for both default clients: lookups and the cancel. */
  stripeFetch?: typeof fetch;
  /** Test seam for the unresolved #ops page. */
  onUnresolvedRevoke?: (info: {
    eventId: string;
    reason: UnresolvedRevokeReason;
  }) => Promise<OpsPageOutcome | undefined>;
  /** Test seam for the refused-Stripe page. */
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
    return markRefundReady(event, eventId, priceDecision, database, deps);
  }
  if (stripeBillingRevokeEnabled(env)) {
    const revoke = chargeRevokeDecision(event);
    if (revoke.action !== 'ignore') {
      return applyChargeRevoke(event, eventId, revoke, database, priceTierMap, deps);
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
    isSubscriptionDeleted(event) &&
    stripeBillingRevokeEnabled(env) &&
    stripeRefundEndsSubscriptionEnabled(env)
  ) {
    const guarded = await guardSubscriptionDeleted(
      event,
      eventId,
      familyId,
      { customerId: refs.customerId, subscriptionId: refs.subscriptionId },
      database,
      deps,
    );
    if (guarded) return guarded;
  }
  const blockedBy = refs.subscriptionId
    ? await subscriptionBlockedBy(database, familyId, refs.subscriptionId, deps)
    : null;
  if (refs.subscriptionId && blockedBy) {
    return claimBlockedGrant(eventId, familyId, refs.subscriptionId, blockedBy, database);
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

interface LinkedCharge {
  familyId: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  subscriptionStatus: string | null;
  subscriptionCreated: number | null;
  subscriptionCustomerId: string | null;
  subscriptionFamilyId: string | null;
  periodStanding: PeriodStanding | null;
}

type BillingTx = Parameters<Parameters<Database['transaction']>[0]>[0];

interface FamilyBillingRow {
  planTier: PlanTier;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
}

/** A required Stripe client is missing. Named, paged, and retried, never read as "nothing". */
class StripeNotConfigured extends Error {}

/** A grant or `.deleted` committed since the family row was read. Rolls the claim back. */
class FamilyChangedDuringRevoke extends Error {}

/**
 * No transaction is held across a Stripe call: read, decide, end the subscription, then
 * claim and write in one transaction. If the process dies after the cancel, the redelivery
 * reads the subscription as ended and finishes the drop. The other order could commit a
 * claimed drop while the subscription keeps billing, and nothing would ever retry it.
 */
async function applyChargeRevoke(
  event: unknown,
  eventId: string,
  decision: Exclude<ChargeRevokeDecision, { action: 'ignore' }>,
  database: Database,
  priceTierMap: PriceTierMap,
  deps: ApplyStripeBillingDeps,
): Promise<ApplyStripeBillingResult> {
  if (await eventAlreadyClaimed(database, eventId)) return { status: 'duplicate' };
  try {
    return await decideChargeRevoke(event, eventId, decision, database, priceTierMap, deps);
  } catch (err) {
    const retry = await retryFromFailure(err, eventId, database, deps);
    if (retry) return retry;
    throw err;
  }
}

async function decideChargeRevoke(
  event: unknown,
  eventId: string,
  decision: Exclude<ChargeRevokeDecision, { action: 'ignore' }>,
  database: Database,
  priceTierMap: PriceTierMap,
  deps: ApplyStripeBillingDeps,
): Promise<ApplyStripeBillingResult> {
  const env = deps.env ?? process.env;
  const endsSubscription = stripeRefundEndsSubscriptionEnabled(env);
  const lookup = chargeLookupFor(deps);
  const linked = await linkCharge(event, lookup);
  const familyId = await familyIdForLinkedCharge(linked, database);
  if (!familyId) return unresolvedRevoke(eventId, 'no_family', null, database, deps);

  const family = await readFamilyBilling(database, familyId);
  if (!family) {
    const claimed = await database.transaction((tx) => claimEvent(tx, eventId));
    if (!claimed) return { status: 'duplicate' };
    console.warn('stripe billing: event references an unknown family', { eventId });
    return { status: 'unknown_family' };
  }

  const facts: RevokeFacts = {
    flagOn: endsSubscription,
    subscriptionId: linked.subscriptionId,
    subscriptionStatus: linked.subscriptionStatus,
    subscriptionCreated: linked.subscriptionCreated,
    namesAnotherFamily:
      linked.subscriptionFamilyId !== null && linked.subscriptionFamilyId !== familyId,
    periodStanding: linked.periodStanding,
    planTier: family.planTier,
    storedSubscriptionId: family.stripeSubscriptionId,
    nowSeconds: wallClockSeconds(deps),
    other: null,
    priceTierMap,
  };
  const partial = decision.action === 'keep' && decision.reason === 'partial_refund';
  const decide = (input: RevokeFacts) =>
    decision.kind === 'refund' ? refundOutcome({ ...input, partial }) : disputeOutcome(input);

  let outcome = decide(facts);
  if (outcome.action === 'needs_scan') {
    const other = await requireLookup(lookup).otherSubscriptions({
      familyId,
      excludeSubscriptionId: linked.subscriptionId,
      customerIds: [linked.customerId, linked.subscriptionCustomerId].filter(
        (id): id is string => id !== null,
      ),
      storedCustomerId: family.stripeCustomerId,
      storedSubscriptionId: family.stripeSubscriptionId,
    });
    outcome = decide({ ...facts, other });
  }
  if (outcome.action === 'needs_scan') {
    throw new Error('stripe billing: the revoke decision asked for a scan it already has');
  }
  if (outcome.action === 'wait') return { status: 'retry', reason: 'search_settling' };
  if (outcome.action === 'unresolved') {
    return unresolvedRevoke(eventId, outcome.reason, familyId, database, deps);
  }
  if (outcome.action === 'drop') {
    const ended = await endSubscriptions(outcome.cancelSubscriptionIds, lookup, deps);
    if (!ended) return cancelFailedRetry(eventId, database, deps);
  }

  const settled = outcome;
  return database.transaction(async (tx): Promise<ApplyStripeBillingResult> => {
    if (!(await claimEvent(tx, eventId))) return { status: 'duplicate' };
    if (settled.action === 'drop') {
      await dropToFree(tx, familyId, family, eventId, decision.kind);
      if (endsSubscription && decision.kind === 'refund') {
        const endedIds = new Set(settled.cancelSubscriptionIds);
        if (linked.subscriptionId) endedIds.add(linked.subscriptionId);
        for (const id of endedIds) {
          await insertEndedMarker(tx, familyId, eventId, id, 'refund', true);
        }
      }
      return { status: 'applied', tier: 'free' };
    }

    if (settled.setTier) {
      await writePlanIfUnchanged(tx, familyId, family, settled.setTier);
      await tx.insert(schema.auditLog).values({
        familyId,
        actor: 'system',
        actionTaken: 'family_plan_updated',
        targetTable: 'families',
        targetId: familyId,
        before: { planTier: family.planTier },
        after: {
          planTier: settled.setTier,
          source: 'stripe',
          stripeEventId: eventId,
          reason: 'duplicate_refunded',
        },
      });
    }
    await tx.insert(schema.auditLog).values({
      familyId,
      actor: 'system',
      actionTaken: 'billing_refunded',
      targetTable: 'families',
      targetId: familyId,
      after: {
        planTier: settled.setTier ?? family.planTier,
        source: 'stripe',
        stripeEventId: eventId,
        reason: settled.reason,
        tierChanged: settled.setTier !== undefined,
      },
    });
    // A refund that lost the race to `.deleted` still blocks late grants for S.
    if (settled.reason === 'already_free' && endsSubscription && linked.subscriptionId) {
      await insertEndedMarker(tx, familyId, eventId, linked.subscriptionId, 'refund', false);
    }
    return { status: 'kept', reason: settled.reason };
  });
}

/**
 * `customer.subscription.deleted` never grants, but it can wrongly drop a family: a
 * duplicate cancelled by hand, or a late delivery after the family bought again. Returns
 * null when nothing else is live, so today's path drops the plan.
 */
async function guardSubscriptionDeleted(
  event: unknown,
  eventId: string,
  familyId: string,
  refs: { customerId: string | null; subscriptionId: string },
  database: Database,
  deps: ApplyStripeBillingDeps,
): Promise<ApplyStripeBillingResult | null> {
  if (await eventAlreadyClaimed(database, eventId)) return { status: 'duplicate' };
  const { subscriptionId } = refs;
  try {
    const ourCancel = await auditVerbNamingSubscription(database, familyId, subscriptionId, [
      'billing_subscription_ended',
    ]);
    if (ourCancel) {
      const claimed = await database.transaction((tx) => claimEvent(tx, eventId));
      return claimed
        ? { status: 'kept', reason: 'subscription_already_ended' }
        : { status: 'duplicate' };
    }

    const family = await readFamilyBilling(database, familyId);
    if (!family) return null;
    const lookup = requireLookup(chargeLookupFor(deps));
    const other = await lookup.otherSubscriptions({
      familyId,
      excludeSubscriptionId: subscriptionId,
      customerIds: refs.customerId ? [refs.customerId] : [],
      storedCustomerId: family.stripeCustomerId,
      storedSubscriptionId: family.stripeSubscriptionId,
    });

    if (other.paid.length > 0 || other.truncated) {
      return database.transaction(async (tx): Promise<ApplyStripeBillingResult> => {
        if (!(await claimEvent(tx, eventId))) return { status: 'duplicate' };
        await insertEndedMarker(
          tx,
          familyId,
          eventId,
          subscriptionId,
          'other_subscription_live',
          false,
        );
        return { status: 'kept', reason: 'active_subscription' };
      });
    }
    if (withinSearchSettle(subscriptionCreatedFromStripeEvent(event), wallClockSeconds(deps))) {
      return { status: 'retry', reason: 'search_settling' };
    }
    if (other.refundedIds.length === 0) return null;

    const ended = await endSubscriptions(other.refundedIds, lookup, deps);
    if (!ended) return cancelFailedRetry(eventId, database, deps);
    return await database.transaction(async (tx): Promise<ApplyStripeBillingResult> => {
      if (!(await claimEvent(tx, eventId))) return { status: 'duplicate' };
      await dropToFree(tx, familyId, family, eventId, 'refund');
      for (const id of [subscriptionId, ...other.refundedIds]) {
        await insertEndedMarker(tx, familyId, eventId, id, 'refund', true);
      }
      return { status: 'applied', tier: 'free' };
    });
  } catch (err) {
    const retry = await retryFromFailure(err, eventId, database, deps);
    if (retry) return retry;
    throw err;
  }
}

function isSubscriptionDeleted(event: unknown): boolean {
  return (
    typeof event === 'object' &&
    event !== null &&
    (event as { type?: unknown }).type === 'customer.subscription.deleted'
  );
}

/** The wall clock, never the event's own `created`, which no redelivery advances. */
function wallClockSeconds(deps: ApplyStripeBillingDeps): number {
  return Math.floor((deps.now ?? new Date()).getTime() / 1000);
}

function chargeLookupFor(deps: ApplyStripeBillingDeps): StripeChargeLookup | null {
  return deps.chargeLookup === undefined
    ? stripeChargeLookupFromEnv(deps.env ?? process.env, deps.stripeFetch)
    : deps.chargeLookup;
}

function requireLookup(lookup: StripeChargeLookup | null): StripeChargeLookup {
  if (!lookup) throw new StripeNotConfigured();
  return lookup;
}

async function endSubscriptions(
  ids: readonly string[],
  lookup: StripeChargeLookup | null,
  deps: ApplyStripeBillingDeps,
): Promise<boolean> {
  if (ids.length === 0) return true;
  const transport = deps.stripeFetch ?? fetch;
  const stripe = stripeRefundApiFromEnv(deps.env ?? process.env, (input, init) =>
    transport(input, { ...init, signal: AbortSignal.timeout(STRIPE_LOOKUP_TIMEOUT_MS) }),
  );
  if (!stripe) throw new StripeNotConfigured();
  const reader = requireLookup(lookup);
  for (const id of ids) {
    if (!(await endSubscription(id, reader, stripe.cancelSubscription))) return false;
  }
  return true;
}

/** Stripe does not document a repeated cancel, so the status read is the proof. */
async function endSubscription(
  id: string,
  lookup: StripeChargeLookup,
  cancel: (subscriptionId: string) => Promise<void>,
): Promise<boolean> {
  if (ENDED_SUBSCRIPTION.has(await lookup.subscriptionStatus(id))) return true;
  try {
    await cancel(id);
    return true;
  } catch {
    return ENDED_SUBSCRIPTION.has(await lookup.subscriptionStatus(id));
  }
}

async function cancelFailedRetry(
  eventId: string,
  database: Database,
  deps: ApplyStripeBillingDeps,
): Promise<RevokeRetry> {
  console.warn('stripe billing: revoke retry', { eventId, reason: 'stripe_cancel_failed' });
  const opsAlert = await pageOps(
    database,
    { site: 'billing_stripe_refused', facts: { call: 'cancel', status: 'unknown' } },
    deps.pageDeps,
  );
  return { status: 'retry', reason: 'stripe_cancel_failed', opsAlert };
}

function refusedStatusFact(
  statusCode: number | null,
): '400' | '401' | '403' | '404' | 'other_4xx' | 'unknown' {
  if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404) {
    return String(statusCode) as '400' | '401' | '403' | '404';
  }
  return statusCode !== null && statusCode >= 400 && statusCode < 500 ? 'other_4xx' : 'unknown';
}

/**
 * A transient failure retries quietly. A refusal also retries, because redelivery after the
 * key is fixed recovers it, and it pages: otherwise it would run out Stripe's three days of
 * retries with no row and no page while the family stays on a plan it was refunded for.
 */
async function retryFromFailure(
  err: unknown,
  eventId: string,
  database: Database,
  deps: ApplyStripeBillingDeps,
): Promise<RevokeRetry | null> {
  if (err instanceof FamilyChangedDuringRevoke) {
    console.warn('stripe billing: revoke retry', { eventId, reason: 'family_changed' });
    return { status: 'retry', reason: 'family_changed' };
  }
  if (err instanceof StripeNotConfigured) {
    console.warn('stripe billing: revoke retry', { eventId, reason: 'stripe_not_configured' });
    const opsAlert = await pageOps(
      database,
      { site: 'billing_stripe_refused', facts: { call: 'lookup', status: 'no_key' } },
      deps.pageDeps,
    );
    return { status: 'retry', reason: 'stripe_not_configured', opsAlert };
  }
  if (!(err instanceof StripeLookupError)) return null;
  console.warn('stripe billing: revoke retry', {
    eventId,
    reason: err.kind === 'transient' ? 'stripe_unavailable' : 'stripe_refused',
    httpStatus: err.statusCode,
  });
  if (err.kind === 'transient') return { status: 'retry', reason: 'stripe_unavailable' };
  const opsAlert = await pageOps(
    database,
    {
      site: 'billing_stripe_refused',
      facts: { call: 'lookup', status: refusedStatusFact(err.statusCode) },
    },
    deps.pageDeps,
  );
  return { status: 'retry', reason: 'stripe_refused', opsAlert };
}

async function linkCharge(
  event: unknown,
  lookup: StripeChargeLookup | null,
): Promise<LinkedCharge> {
  const link = chargeLinkFromStripeEvent(event);
  const base: LinkedCharge = {
    familyId: familyIdFromStripeEvent(event),
    customerId: stripeRefsFromStripeEvent(event).customerId,
    subscriptionId: link.subscriptionId,
    subscriptionStatus: link.subscriptionStatus,
    subscriptionCreated: null,
    subscriptionCustomerId: null,
    subscriptionFamilyId: null,
    periodStanding: null,
  };
  // A bare id with no status is not "not live": it has to be read.
  const needsLookup =
    !base.subscriptionId || !base.subscriptionStatus || (!base.familyId && !base.customerId);
  if (!needsLookup || !link.chargeId) return base;
  const found = await requireLookup(lookup).lookupCharge(link.chargeId);
  const merged: LinkedCharge = {
    ...base,
    familyId: base.familyId ?? found.familyId,
    customerId: base.customerId ?? found.customerId,
  };
  if (!found.subscriptionId) return merged;
  return {
    ...merged,
    subscriptionId: found.subscriptionId,
    subscriptionStatus: found.subscriptionStatus,
    subscriptionCreated: found.subscriptionCreated,
    subscriptionCustomerId: found.subscriptionCustomerId,
    subscriptionFamilyId: found.subscriptionFamilyId,
    periodStanding: found.periodStanding,
  };
}

async function familyIdForLinkedCharge(
  linked: LinkedCharge,
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

async function readFamilyBilling(
  database: Database,
  familyId: string,
): Promise<FamilyBillingRow | null> {
  const rows = await database
    .select({
      planTier: schema.families.planTier,
      stripeCustomerId: schema.families.stripeCustomerId,
      stripeSubscriptionId: schema.families.stripeSubscriptionId,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  return rows[0] ?? null;
}

async function eventAlreadyClaimed(database: Database, eventId: string): Promise<boolean> {
  const rows = await database
    .select({ id: schema.stripeBillingEvents.id })
    .from(schema.stripeBillingEvents)
    .where(eq(schema.stripeBillingEvents.eventId, eventId))
    .limit(1);
  return rows.length > 0;
}

/** Conditional on what the decision read, so a grant that landed since is never overwritten. */
async function writePlanIfUnchanged(
  tx: BillingTx,
  familyId: string,
  read: FamilyBillingRow,
  planTier: PlanTier,
): Promise<void> {
  const updated = await tx
    .update(schema.families)
    .set({ planTier, updatedAt: new Date() })
    .where(
      and(
        eq(schema.families.id, familyId),
        eq(schema.families.planTier, read.planTier),
        read.stripeSubscriptionId === null
          ? isNull(schema.families.stripeSubscriptionId)
          : eq(schema.families.stripeSubscriptionId, read.stripeSubscriptionId),
      ),
    )
    .returning({ id: schema.families.id });
  if (updated.length === 0) throw new FamilyChangedDuringRevoke();
}

async function dropToFree(
  tx: BillingTx,
  familyId: string,
  read: FamilyBillingRow,
  eventId: string,
  reason: 'refund' | 'dispute',
): Promise<void> {
  await writePlanIfUnchanged(tx, familyId, read, 'free');
  await tx.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'family_plan_updated',
    targetTable: 'families',
    targetId: familyId,
    before: { planTier: read.planTier },
    after: { planTier: 'free', source: 'stripe', stripeEventId: eventId, reason },
  });
}

/** Names a subscription that is over, so no late event for it can bring the tier back. */
async function insertEndedMarker(
  tx: BillingTx,
  familyId: string,
  eventId: string,
  subscriptionId: string,
  reason: 'refund' | 'other_subscription_live',
  tierChanged: boolean,
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'billing_subscription_ended',
    targetTable: 'families',
    targetId: familyId,
    after: { source: 'stripe', stripeEventId: eventId, subscriptionId, reason, tierChanged },
  });
}

async function unresolvedRevoke(
  eventId: string,
  reason: UnresolvedRevokeReason,
  familyId: string | null,
  database: Database,
  deps: ApplyStripeBillingDeps,
): Promise<ApplyStripeBillingResult> {
  const claimed = await database.transaction(async (tx) => {
    if (!(await claimEvent(tx, eventId))) return false;
    if (familyId) {
      await tx.insert(schema.auditLog).values({
        familyId,
        actor: 'system',
        actionTaken: 'billing_revoke_unresolved',
        targetTable: 'families',
        targetId: familyId,
        after: { source: 'stripe', stripeEventId: eventId, reason, tierChanged: false },
      });
    }
    return true;
  });
  if (!claimed) return { status: 'duplicate' };
  const alert = deps.onUnresolvedRevoke ?? alertUnresolvedBillingRevoke;
  const posted = await alert({ eventId, reason });
  const opsAlert = posted ?? 'sent';
  console.warn('stripe billing: revoke unresolved', { eventId, reason, opsAlert });
  return { status: 'unresolved', reason, opsAlert };
}

async function claimEvent(tx: BillingTx, eventId: string): Promise<boolean> {
  const claim = await tx
    .insert(schema.stripeBillingEvents)
    .values({ eventId })
    .onConflictDoNothing()
    .returning({ id: schema.stripeBillingEvents.id });
  return claim.length > 0;
}

type GrantBlockVerb = 'billing_refund_ready' | 'billing_subscription_ended';
const GRANT_BLOCK_VERBS: readonly GrantBlockVerb[] = [
  'billing_refund_ready',
  'billing_subscription_ended',
];

async function auditVerbNamingSubscription(
  database: Database,
  familyId: string,
  subscriptionId: string,
  verbs: readonly GrantBlockVerb[],
): Promise<GrantBlockVerb | null> {
  const rows = await database
    .select({ after: schema.auditLog.after, actionTaken: schema.auditLog.actionTaken })
    .from(schema.auditLog)
    .where(
      and(eq(schema.auditLog.familyId, familyId), inArray(schema.auditLog.actionTaken, [...verbs])),
    )
    .limit(50);
  const match = rows.find((row) => auditSubscriptionId(row.after) === subscriptionId);
  return match ? (match.actionTaken as GrantBlockVerb) : null;
}

/** Read with no flag check, so a marker keeps blocking if the flag is later turned off. */
async function subscriptionBlockedBy(
  database: Database,
  familyId: string,
  subscriptionId: string,
  deps: ApplyStripeBillingDeps,
): Promise<GrantBlockVerb | null> {
  if (deps.subscriptionBlocked) {
    return (await deps.subscriptionBlocked(familyId, subscriptionId))
      ? 'billing_refund_ready'
      : null;
  }
  return auditVerbNamingSubscription(database, familyId, subscriptionId, GRANT_BLOCK_VERBS);
}

async function claimBlockedGrant(
  eventId: string,
  familyId: string,
  subscriptionId: string,
  prior: GrantBlockVerb,
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
        prior,
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
