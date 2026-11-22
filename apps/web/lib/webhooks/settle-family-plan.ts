import { type Database, schema } from '@hale/db';
import type { PlanTier } from '@hale/types';
import { and, eq, sql } from 'drizzle-orm';
import {
  type RefundPendingReason,
  type StripeInvoiceFacts,
  StripeLookupError,
  type StripePlanReader,
  type StripeSubscriptionRead,
  invoicePeriodFit,
  stripePlanReaderFromEnv,
} from '~/lib/billing/stripe-charge-context';
import { alertUnsettledBillingPlan } from '~/lib/monitoring/billing-tier-alert';
import { type OpsPagerOutcome, pageOps } from '~/lib/monitoring/failure-page';
import type { ApplyStripeBillingDeps, ApplyStripeBillingResult } from './stripe-billing-apply.js';
import {
  ENDED_SUBSCRIPTION,
  type PaidTier,
  type PriceTierMap,
  decidePlanTier,
} from './stripe-billing.js';

/**
 * With STRIPE_REFUND_ENDS_SUBSCRIPTION_ENABLED on, a Stripe event no longer says what the
 * plan is. It says "go and look": this reads the family's subscriptions, ends the one
 * subscription a refund proved was refunded, and sets the tier from what is still paid.
 *
 * No transaction is held across a Stripe call. Each settle reads the family row's version
 * before it reads Stripe and writes only if that version is unchanged, so two deliveries
 * that interleave anywhere cannot leave the plan on what an older read saw. The cancel
 * comes before the commit: a crash between them redelivers, reads `canceled`, and settles.
 */

const SETTLE_ATTEMPTS = 3;
/** A failure that clears within a day leaves no row. Stripe retries for up to three. */
export const UNSETTLED_RECORD_AFTER_SECONDS = 86_400;
const LATEST_PERIOD_REASONS: ReadonlySet<string> = new Set([
  'subscription_create',
  'subscription_cycle',
]);
const REFUND_PENDING_PAGES: ReadonlySet<RefundPendingReason> = new Set([
  'insufficient_funds',
  'requires_action',
  'unknown',
]);

export type PlanHoldReason =
  | 'mixed_tiers'
  | 'unmapped_price'
  | 'truncated'
  | 'no_stripe_identity'
  | 'no_subscription_on_event'
  | 'subscription_unresolved'
  | 'current_period_unproven'
  | 'refund_not_settled'
  | 'period_partly_refunded'
  | 'cancel_would_stop_collection';

type UnsettledRowReason =
  | PlanHoldReason
  | 'stripe_refused'
  | 'stripe_unavailable'
  | 'refund_pending'
  | 'resettle_failed';

export interface PlanRetry {
  status: 'retry';
  reason:
    | 'stripe_unavailable'
    | 'stripe_refused'
    | 'stripe_not_configured'
    | 'stripe_cancel_failed'
    | 'refund_pending'
    | 'family_changed';
  opsAlert?: OpsPagerOutcome;
}

export type PlanSignal =
  | {
      kind: 'refund';
      eventId: string;
      eventCreated: number | null;
      customerId: string | null;
      subscriptionId: string;
      invoice: StripeInvoiceFacts;
      chargeId: string;
      chargeAmountCaptured: number;
    }
  | {
      kind: 'lifecycle';
      eventId: string;
      eventCreated: number | null;
      customerId: string | null;
      subscriptionId: string | null;
      /** The tier the event itself resolved. Null for `.deleted`: its `free` is not a price. */
      eventTier: PaidTier | null;
      paidEvent: boolean;
    };

type BillingTx = Parameters<Parameters<Database['transaction']>[0]>[0];

type ClearsOn = 'decision' | 'subscription_ended';

interface HeldPlan {
  stripeEventId: string;
  subscriptionId: string | null;
  periodEnd: number | null;
  clearsOn: ClearsOn;
}

interface FamilyRead {
  version: string;
  planTier: PlanTier;
  storedCustomerId: string | null;
  storedSubscriptionId: string | null;
  comped: boolean;
  refundReadyIds: readonly string[];
  customerIds: readonly string[];
  holds: readonly HeldPlan[];
}

type Outcome =
  | {
      kind: 'hold';
      reason: PlanHoldReason;
      clearsOn: ClearsOn;
      subscription: StripeSubscriptionRead | null;
    }
  | { kind: 'older_invoice'; subscription: StripeSubscriptionRead }
  | {
      kind: 'set';
      tier: PlanTier;
      entitledIds: readonly string[];
      subscription: StripeSubscriptionRead | null;
    };

/** A required Stripe client is missing. Named, paged, and retried, never read as "nothing". */
class StripeNotConfigured extends Error {}

/** The family row moved since it was read. Rolls the claim back. */
class FamilyChangedDuringSettle extends Error {}

class RefundStillPending extends Error {
  constructor(
    readonly reason: RefundPendingReason,
    readonly periodEnd: number | null,
  ) {
    super(`refund pending: ${reason}`);
  }
}

export function planReaderFor(deps: ApplyStripeBillingDeps): StripePlanReader {
  const reader = stripePlanReaderFromEnv(deps.env ?? process.env, deps.stripeFetch);
  if (!reader) throw new StripeNotConfigured();
  return reader;
}

export async function claimEvent(tx: BillingTx, eventId: string): Promise<boolean> {
  const claim = await tx
    .insert(schema.stripeBillingEvents)
    .values({ eventId })
    .onConflictDoNothing()
    .returning({ id: schema.stripeBillingEvents.id });
  return claim.length > 0;
}

export async function eventAlreadyClaimed(database: Database, eventId: string): Promise<boolean> {
  const rows = await database
    .select({ id: schema.stripeBillingEvents.id })
    .from(schema.stripeBillingEvents)
    .where(eq(schema.stripeBillingEvents.eventId, eventId))
    .limit(1);
  return rows.length > 0;
}

export async function settleFamilyPlan(
  familyId: string,
  signal: PlanSignal,
  database: Database,
  priceTierMap: PriceTierMap,
  deps: ApplyStripeBillingDeps,
): Promise<ApplyStripeBillingResult> {
  if (await eventAlreadyClaimed(database, signal.eventId)) return { status: 'duplicate' };
  try {
    const reader = planReaderFor(deps);
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
      const family = await readFamily(database, familyId);
      if (!family) return claimUnknownFamily(signal.eventId, familyId, database);
      const { outcome, subscriptions } = await decide(
        family,
        familyId,
        signal,
        reader,
        priceTierMap,
      );
      try {
        const result = await commit(familyId, family, signal, outcome, subscriptions, database);
        if (result.status === 'unresolved') return await pageHold(result, signal.eventId, deps);
        return result;
      } catch (err) {
        if (!(err instanceof FamilyChangedDuringSettle)) throw err;
      }
    }
    console.warn('stripe billing: settle retry', {
      eventId: signal.eventId,
      reason: 'family_changed',
    });
    return { status: 'retry', reason: 'family_changed' };
  } catch (err) {
    const retry = await retryFromFailure(
      err,
      {
        eventId: signal.eventId,
        familyId,
        eventCreated: signal.eventCreated,
        refund: signal.kind === 'refund',
        subscriptionId: signal.subscriptionId,
        periodEnd: signal.kind === 'refund' ? refundedPeriodEnd(signal) : null,
      },
      database,
      deps,
    );
    if (retry) return retry;
    throw err;
  }
}

async function readFamily(database: Database, familyId: string): Promise<FamilyRead | null> {
  // One statement, so the version and every marker come from one snapshot. These are raw
  // `families.` references because drizzle unqualifies a column in a single-table select.
  const [row] = await database
    .select({
      version: sql<string>`families.xmin::text`,
      planTier: schema.families.planTier,
      storedCustomerId: schema.families.stripeCustomerId,
      storedSubscriptionId: schema.families.stripeSubscriptionId,
      comped: sql<boolean>`exists (
        select 1 from audit_log a
        where a.family_id = families.id and a.action_taken = 'family_plan_comped'
      )`,
      refundReady: sql<string>`coalesce((
        select json_agg(distinct a.after->>'subscriptionId')::text from audit_log a
        where a.family_id = families.id
          and a.action_taken = 'billing_refund_ready'
          and a.after->>'subscriptionId' is not null
      ), '[]')`,
      customers: sql<string>`coalesce((
        select json_agg(distinct a.after->>'stripeCustomerId')::text from audit_log a
        where a.family_id = families.id
          and a.action_taken in ('family_plan_updated', 'billing_refunded', 'billing_plan_unsettled')
          and a.after->>'stripeCustomerId' is not null
      ), '[]')`,
      holds: sql<string>`coalesce((
        select json_agg(held.after)::text from audit_log held
        where held.family_id = families.id
          and held.action_taken = 'billing_plan_unsettled'
          and held.after->>'state' = 'held'
          and not exists (
            select 1 from audit_log cleared
            where cleared.family_id = families.id
              and cleared.action_taken = 'billing_plan_unsettled'
              and cleared.after->>'state' = 'cleared'
              and cleared.after->>'clearsEventId' = held.after->>'stripeEventId'
          )
      ), '[]')`,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  if (!row) return null;
  return {
    version: row.version,
    planTier: row.planTier,
    storedCustomerId: row.storedCustomerId,
    storedSubscriptionId: row.storedSubscriptionId,
    comped: row.comped,
    refundReadyIds: JSON.parse(row.refundReady) as string[],
    customerIds: JSON.parse(row.customers) as string[],
    holds: JSON.parse(row.holds) as HeldPlan[],
  };
}

async function decide(
  family: FamilyRead,
  familyId: string,
  signal: PlanSignal,
  reader: StripePlanReader,
  priceTierMap: PriceTierMap,
): Promise<{ outcome: Outcome; subscriptions: readonly StripeSubscriptionRead[] }> {
  const rememberedCustomerIds = [
    ...new Set([
      ...(family.storedCustomerId ? [family.storedCustomerId] : []),
      ...family.customerIds,
    ]),
  ];
  if (
    !signal.customerId &&
    !signal.subscriptionId &&
    !family.storedSubscriptionId &&
    rememberedCustomerIds.length === 0
  ) {
    return { outcome: hold('no_stripe_identity', 'decision', null), subscriptions: [] };
  }
  const { subscriptions, truncated } = await reader.familySubscriptions({
    familyId,
    eventCustomerId: signal.customerId,
    eventSubscriptionId: signal.subscriptionId,
    rememberedCustomerIds,
    rememberedSubscriptionIds: [
      ...(family.storedSubscriptionId ? [family.storedSubscriptionId] : []),
      ...family.holds.flatMap((row) => row.subscriptionId ?? []),
    ],
  });
  const own = subscriptions.find((row) => row.id === signal.subscriptionId) ?? null;
  if (truncated) return { outcome: hold('truncated', 'decision', own), subscriptions };

  if (signal.kind === 'refund') {
    const judged = await judgeRefund(signal, own, reader);
    if (judged) return { outcome: judged, subscriptions };
  }

  const decision = decidePlanTier({
    subscriptions,
    refundReadyIds: new Set(family.refundReadyIds),
    openHoldIds: openRefundHoldIds(family, subscriptions),
    currentTier: family.planTier,
    comped: family.comped,
    priceTierMap,
    eventSubscriptionId: signal.subscriptionId,
    eventGrant:
      signal.kind === 'lifecycle' && signal.subscriptionId && signal.eventTier
        ? { subscriptionId: signal.subscriptionId, tier: signal.eventTier }
        : null,
  });
  if (decision.action === 'hold') {
    return { outcome: hold(decision.reason, 'decision', own), subscriptions };
  }
  if (
    signal.kind === 'lifecycle' &&
    signal.paidEvent &&
    !signal.subscriptionId &&
    decision.tier === 'free'
  ) {
    return { outcome: hold('no_subscription_on_event', 'decision', null), subscriptions };
  }
  return {
    outcome: {
      kind: 'set',
      tier: decision.tier,
      entitledIds: decision.entitledIds,
      subscription: own,
    },
    subscriptions,
  };
}

function hold(
  reason: PlanHoldReason,
  clearsOn: ClearsOn,
  subscription: StripeSubscriptionRead | null,
): Outcome {
  return { kind: 'hold', reason, clearsOn, subscription };
}

function refundedPeriodEnd(signal: Extract<PlanSignal, { kind: 'refund' }>): number | null {
  const ends = signal.invoice.lines.flatMap((line) =>
    line.subscriptionId === signal.subscriptionId && line.periodEnd !== null ? line.periodEnd : [],
  );
  return ends.length > 0 ? Math.max(...ends) : null;
}

function currentPeriodEnd(subscription: StripeSubscriptionRead): number | null {
  const ends = subscription.items.flatMap((item) => item.currentPeriodEnd ?? []);
  return ends.length > 0 ? Math.max(...ends) : null;
}

/**
 * The only code that writes to Stripe. Returns an outcome to stop at, or null once the
 * subscription has ended and the tier can be decided. Only the subscription this refund's
 * charge paid is ever cancelled, and only once Stripe reports the refund `succeeded`.
 */
async function judgeRefund(
  signal: Extract<PlanSignal, { kind: 'refund' }>,
  target: StripeSubscriptionRead | null,
  reader: StripePlanReader,
): Promise<Outcome | null> {
  if (!target) return hold('subscription_unresolved', 'decision', null);
  if (ENDED_SUBSCRIPTION.has(target.status)) return null;
  const refundHold = (reason: PlanHoldReason) => hold(reason, 'subscription_ended', target);

  const fit = invoicePeriodFit(signal.invoice, target);
  if (fit === 'item_replaced') return refundHold('current_period_unproven');
  if (fit === 'older') {
    const latest =
      target.latestInvoiceId === signal.invoice.id &&
      signal.invoice.billingReason !== null &&
      LATEST_PERIOD_REASONS.has(signal.invoice.billingReason);
    return latest
      ? refundHold('current_period_unproven')
      : { kind: 'older_invoice', subscription: target };
  }

  const refund = await reader.refundState(signal.chargeId, signal.chargeAmountCaptured);
  if (refund.state === 'pending') {
    throw new RefundStillPending(refund.reason, currentPeriodEnd(target));
  }
  if (refund.state !== 'settled') return refundHold('refund_not_settled');
  const ownInvoiceListed = target.periodInvoices.some((row) => row.id === signal.invoice.id);
  if (!ownInvoiceListed || target.periodInvoices.some((row) => !row.refunded)) {
    return refundHold('period_partly_refunded');
  }
  if (await reader.otherOpenInvoices(target.customerId, target.id)) {
    return refundHold('cancel_would_stop_collection');
  }
  await reader.cancelSubscription(target.id);
  target.status = 'canceled';
  return null;
}

/** A refund hold ends with its subscription, or with a new period someone actually paid for. */
function refundHoldEnded(row: HeldPlan, subscription: StripeSubscriptionRead): boolean {
  if (ENDED_SUBSCRIPTION.has(subscription.status)) return true;
  const end = currentPeriodEnd(subscription);
  const rolledOver = row.periodEnd !== null && end !== null && end > row.periodEnd;
  return rolledOver && subscription.periodInvoices.some((invoice) => !invoice.refunded);
}

function openRefundHoldIds(
  family: FamilyRead,
  subscriptions: readonly StripeSubscriptionRead[],
): Set<string> {
  const open = subscriptions.filter((subscription) =>
    family.holds.some(
      (row) =>
        row.clearsOn === 'subscription_ended' &&
        row.subscriptionId === subscription.id &&
        !refundHoldEnded(row, subscription),
    ),
  );
  return new Set(open.map((subscription) => subscription.id));
}

function clearedEventIds(
  family: FamilyRead,
  signal: PlanSignal,
  outcome: Outcome,
  subscriptions: readonly StripeSubscriptionRead[],
): string[] {
  const cleared = new Set<string>();
  for (const row of family.holds) {
    if (outcome.kind !== 'hold' && row.stripeEventId === signal.eventId) {
      cleared.add(row.stripeEventId);
    } else if (row.clearsOn === 'decision') {
      if (outcome.kind === 'set') cleared.add(row.stripeEventId);
    } else {
      const subscription = subscriptions.find((sub) => sub.id === row.subscriptionId);
      if (subscription && refundHoldEnded(row, subscription)) cleared.add(row.stripeEventId);
    }
  }
  return [...cleared];
}

interface PlannedCommit {
  result: ApplyStripeBillingResult;
  tier: PlanTier | null;
  storeRefs: boolean;
  row: { actionTaken: string; before?: unknown; after: Record<string, unknown> } | null;
}

function planCommit(family: FamilyRead, signal: PlanSignal, outcome: Outcome): PlannedCommit {
  const subscription = outcome.subscription;
  const facts = {
    source: 'stripe',
    stripeCustomerId: signal.customerId ?? subscription?.customerId ?? null,
    ...(subscription
      ? { subscriptionId: subscription.id, subscriptionStatus: subscription.status }
      : {}),
  };
  const before = { planTier: family.planTier };

  if (outcome.kind === 'hold') {
    return {
      result: { status: 'unresolved', reason: outcome.reason, opsAlert: 'sent' },
      tier: null,
      storeRefs: false,
      row: {
        actionTaken: 'billing_plan_unsettled',
        after: {
          ...facts,
          state: 'held',
          reason: outcome.reason,
          stripeEventId: signal.eventId,
          subscriptionId: signal.subscriptionId,
          periodEnd: subscription ? currentPeriodEnd(subscription) : null,
          clearsOn: outcome.clearsOn,
        },
      },
    };
  }

  const refundedRow = (reason: string) => ({
    actionTaken: 'billing_refunded',
    after: {
      ...facts,
      planTier: family.planTier,
      stripeEventId: signal.eventId,
      reason,
      tierChanged: false,
    },
  });
  if (outcome.kind === 'older_invoice') {
    return {
      result: { status: 'kept', reason: 'older_invoice' },
      tier: null,
      storeRefs: false,
      row: refundedRow('older_invoice'),
    };
  }

  const moved = outcome.tier !== family.planTier;
  const updatedRow = (after: Record<string, unknown>) => ({
    actionTaken: 'family_plan_updated',
    before,
    after: { ...facts, planTier: outcome.tier, ...after },
  });

  if (signal.kind === 'refund') {
    return moved
      ? {
          result: { status: 'applied', tier: outcome.tier },
          tier: outcome.tier,
          storeRefs: false,
          row: updatedRow({ stripeEventId: signal.eventId, reason: 'refund' }),
        }
      : {
          result: { status: 'kept', reason: 'plan_unchanged' },
          tier: null,
          storeRefs: false,
          row: refundedRow('plan_unchanged'),
        };
  }

  const entitled =
    signal.subscriptionId !== null && outcome.entitledIds.includes(signal.subscriptionId);
  if (entitled || (!signal.paidEvent && moved)) {
    return {
      result: { status: 'applied', tier: outcome.tier },
      tier: outcome.tier,
      storeRefs: entitled,
      row: updatedRow({ stripeEventId: signal.eventId }),
    };
  }
  // Not `stripeEventId`: a redelivery reads that key as proof this event granted the plan.
  return {
    result: { status: 'kept', reason: 'not_entitled' },
    tier: moved ? outcome.tier : null,
    storeRefs: false,
    row: moved ? updatedRow({ settledByEventId: signal.eventId }) : null,
  };
}

async function commit(
  familyId: string,
  family: FamilyRead,
  signal: PlanSignal,
  outcome: Outcome,
  subscriptions: readonly StripeSubscriptionRead[],
  database: Database,
): Promise<ApplyStripeBillingResult> {
  const planned = planCommit(family, signal, outcome);
  const cleared = clearedEventIds(family, signal, outcome, subscriptions);
  return database.transaction(async (tx) => {
    if (!(await claimEvent(tx, signal.eventId))) return { status: 'duplicate' };
    const updated = await tx
      .update(schema.families)
      .set({
        updatedAt: new Date(),
        ...(planned.tier ? { planTier: planned.tier } : {}),
        ...(planned.storeRefs && signal.customerId ? { stripeCustomerId: signal.customerId } : {}),
        ...(planned.storeRefs && signal.subscriptionId
          ? { stripeSubscriptionId: signal.subscriptionId }
          : {}),
      })
      .where(and(eq(schema.families.id, familyId), sql`families.xmin = ${family.version}::xid`))
      .returning({ id: schema.families.id });
    if (updated.length === 0) throw new FamilyChangedDuringSettle();

    const audit = { familyId, actor: 'system', targetTable: 'families', targetId: familyId };
    if (planned.row) await tx.insert(schema.auditLog).values({ ...audit, ...planned.row });
    for (const clearsEventId of cleared) {
      await tx.insert(schema.auditLog).values({
        ...audit,
        actionTaken: 'billing_plan_unsettled',
        after: { source: 'stripe', state: 'cleared', clearsEventId },
      });
    }
    return planned.result;
  });
}

async function pageHold(
  result: Extract<ApplyStripeBillingResult, { status: 'unresolved' }>,
  eventId: string,
  deps: ApplyStripeBillingDeps,
): Promise<ApplyStripeBillingResult> {
  const alert = deps.onPlanUnsettled ?? alertUnsettledBillingPlan;
  const posted = await alert({ eventId, reason: result.reason });
  const opsAlert = posted ?? 'sent';
  console.warn('stripe billing: plan held', { eventId, reason: result.reason, opsAlert });
  return { ...result, opsAlert };
}

async function claimUnknownFamily(
  eventId: string,
  familyId: string,
  database: Database,
): Promise<ApplyStripeBillingResult> {
  const claimed = await database.transaction((tx) => claimEvent(tx, eventId));
  if (!claimed) return { status: 'duplicate' };
  console.warn(
    `stripe billing: event ${eventId} references unknown family ${familyId} — acknowledged, not applied`,
  );
  return { status: 'unknown_family' };
}

function refusedStatusFact(
  statusCode: number | null,
): '400' | '401' | '403' | '404' | 'other_4xx' | 'unknown' {
  if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404) {
    return String(statusCode) as '400' | '401' | '403' | '404';
  }
  return statusCode !== null && statusCode >= 400 && statusCode < 500 ? 'other_4xx' : 'unknown';
}

export interface RetryContext {
  eventId: string;
  familyId: string | null;
  eventCreated: number | null;
  refund: boolean;
  subscriptionId: string | null;
  periodEnd: number | null;
}

/**
 * Stripe has not given a final answer, so the event is not claimed and Stripe redelivers.
 * A refusal pages hourly, because it would otherwise run out Stripe's three days of retries
 * with no trace. Past a day, every kind of failure leaves one held row the hourly count sees.
 */
export async function retryFromFailure(
  err: unknown,
  context: RetryContext,
  database: Database,
  deps: ApplyStripeBillingDeps,
): Promise<PlanRetry | null> {
  const logRetry = (reason: PlanRetry['reason']) =>
    console.warn('stripe billing: settle retry', { eventId: context.eventId, reason });

  if (err instanceof StripeNotConfigured) {
    logRetry('stripe_not_configured');
    const opsAlert = await pageOps(
      database,
      { site: 'billing_stripe_refused', facts: { call: 'lookup', status: 'no_key' } },
      deps.pageDeps,
    );
    await recordUnsettled(context, 'stripe_refused', context.periodEnd, database, deps);
    return { status: 'retry', reason: 'stripe_not_configured', opsAlert };
  }
  if (err instanceof RefundStillPending) {
    logRetry('refund_pending');
    const opsAlert = REFUND_PENDING_PAGES.has(err.reason)
      ? await pageOps(
          database,
          {
            site: 'billing_refund_pending',
            facts: { reason: err.reason as 'insufficient_funds' | 'requires_action' | 'unknown' },
          },
          deps.pageDeps,
        )
      : undefined;
    await recordUnsettled(context, 'refund_pending', err.periodEnd, database, deps);
    return { status: 'retry', reason: 'refund_pending', ...(opsAlert ? { opsAlert } : {}) };
  }
  if (!(err instanceof StripeLookupError)) return null;
  if (err.kind === 'transient') {
    logRetry('stripe_unavailable');
    await recordUnsettled(context, 'stripe_unavailable', context.periodEnd, database, deps);
    return { status: 'retry', reason: 'stripe_unavailable' };
  }
  const reason = err.call === 'cancel' ? 'stripe_cancel_failed' : 'stripe_refused';
  logRetry(reason);
  const opsAlert = await pageOps(
    database,
    {
      site: 'billing_stripe_refused',
      facts: { call: err.call, status: refusedStatusFact(err.statusCode) },
    },
    deps.pageDeps,
  );
  await recordUnsettled(context, 'stripe_refused', context.periodEnd, database, deps);
  return { status: 'retry', reason, opsAlert };
}

async function recordUnsettled(
  context: RetryContext,
  reason: 'stripe_refused' | 'stripe_unavailable' | 'refund_pending',
  periodEnd: number | null,
  database: Database,
  deps: ApplyStripeBillingDeps,
): Promise<void> {
  if (!context.familyId || context.eventCreated === null) return;
  const nowSeconds = Math.floor((deps.now ?? new Date()).getTime() / 1000);
  if (nowSeconds - context.eventCreated < UNSETTLED_RECORD_AFTER_SECONDS) return;
  await writeHeldRow(
    context.familyId,
    context.eventId,
    reason,
    {
      subscriptionId: context.subscriptionId,
      periodEnd,
      clearsOn: context.refund ? 'subscription_ended' : 'decision',
    },
    database,
    deps,
  );
}

/** One row per event: a redelivery of a failure that already has a row adds nothing. */
export async function writeHeldRow(
  familyId: string,
  eventId: string,
  reason: UnsettledRowReason,
  scope: { subscriptionId: string | null; periodEnd: number | null; clearsOn: ClearsOn },
  database: Database,
  deps: ApplyStripeBillingDeps,
): Promise<void> {
  const existing = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'billing_plan_unsettled'),
        sql`${schema.auditLog.after}->>'state' = 'held'`,
        sql`${schema.auditLog.after}->>'stripeEventId' = ${eventId}`,
      ),
    )
    .limit(1);
  if (existing.length > 0) return;
  await database.insert(schema.auditLog).values({
    familyId,
    actor: 'system',
    actionTaken: 'billing_plan_unsettled',
    targetTable: 'families',
    targetId: familyId,
    after: { source: 'stripe', state: 'held', reason, stripeEventId: eventId, ...scope },
  });
  const alert = deps.onPlanUnsettled ?? alertUnsettledBillingPlan;
  await alert({ eventId, reason });
}
