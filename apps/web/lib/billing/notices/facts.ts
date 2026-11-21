import { type BillingNotice, type Database, schema } from '@hale/db';
import { and, asc, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  CANADA_ZONES,
  type ParentClock,
  UNITED_STATES_ZONES,
  readParentClock,
  realZone,
} from '~/lib/channel/family-tz';
import { readParentLanguage } from '~/lib/channel/parent-language';
import {
  type BillingClaimFacts,
  type BillingPlanName,
  billingDollars,
} from '~/lib/channel/reconcile/billing-text';
import { dayKeyIn } from '~/lib/plan/spine';
import type { BillingNoticeFacts } from './compose';
import type { NoticeSubscription, NoticeSubscriptionReader } from './subscription-read';

/**
 * VIL-735 · what the text may say, read after the webhook has applied: the tier from
 * Hale's own table, the period end from Stripe and the amounts from the events. Nothing
 * predicts what a refund did to the tier, because STRIPE_BILLING_REVOKE_ENABLED changes
 * it: the row is read and the text says what the row says.
 */

const PLAN_NAME: Record<string, BillingPlanName> = { free: 'Free', plus: 'Plus', family: 'Max' };

/** One purchase writes several plan rows around the subscription's own start. */
const PURCHASE_ROWS_MS = 60_000;
/** A refund landed before its cancel: how long the deletion event gets to arrive. */
const LAGGING_CANCEL_RETRY_MS = 5 * 60_000;
const LAGGING_CANCEL_LIMIT_MS = 30 * 60_000;
const ENDED_STRIPE_STATUSES: ReadonlySet<string> = new Set(['canceled', 'incomplete_expired']);

export type NoticeFactsRead =
  | { status: 'ready'; writer: BillingNoticeFacts; claim: BillingClaimFacts }
  | {
      status: 'drop';
      reason: 'plan_not_paid' | 'plan_mismatch' | 'duplicate_payment' | 'plan_state_unsettled';
      page: boolean;
    }
  /** Stripe says the subscription ended and Hale has not heard yet: back to open. */
  | { status: 'wait'; until: Date }
  | { status: 'failed'; reason: 'subscription_unread' };

/**
 * The parent's clock for this lane. With the resolve flag off a family with no stored zone
 * reads as UTC, whose daytime is the middle of the night in Toronto, so that one case
 * becomes every Canadian and US zone. It never forces the flag on, which would write
 * `resolved_timezone` and an audit row while that flag is dark.
 */
export async function billingNoticeClock(
  database: Database,
  parentUserId: string,
): Promise<ParentClock> {
  const clock = await readParentClock(database, parentUserId);
  return clock.kind === 'zone' && realZone(clock.timeZone) === null
    ? { kind: 'unresolved', zones: [...CANADA_ZONES, ...UNITED_STATES_ZONES] }
    : clock;
}

interface PaidThrough {
  date: string;
  year: number;
  month: number;
  day: number;
  renews: boolean;
}

/** `past_due` is left out: its latest invoice failed, so that is not a paid-through date.
 * On an unresolved clock the date is said only when every candidate zone agrees on it. */
function paidThroughFor(subscription: NoticeSubscription, clock: ParentClock): PaidThrough | null {
  if (subscription.status !== 'active' && subscription.status !== 'trialing') return null;
  const end = subscription.currentPeriodEnd;
  if (!end) return null;
  const zones = clock.kind === 'zone' ? [clock.timeZone] : clock.zones;
  const days = new Set(zones.map((zone) => dayKeyIn(end, zone)));
  const [only, ...others] = [...days];
  if (only === undefined || others.length > 0) return null;
  const [year, month, day] = only.split('-').map(Number) as [number, number, number];
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
  return { date, year, month, day, renews: !subscription.cancelAtPeriodEnd };
}

function planTierOf(after: unknown): string | null {
  if (typeof after !== 'object' || after === null) return null;
  const tier = (after as { planTier?: unknown }).planTier;
  return typeof tier === 'string' ? tier : null;
}

/** What the family held before this purchase. `before.planTier` cannot say, because the
 * checkout, subscription and invoice events each write a row and arrive in any order. */
async function planBeforePurchase(
  database: Database,
  familyId: string,
  subscriptionCreatedAt: Date,
): Promise<string> {
  const [prior] = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'family_plan_updated'),
        lt(
          schema.auditLog.occurredAt,
          new Date(subscriptionCreatedAt.getTime() - PURCHASE_ROWS_MS),
        ),
      ),
    )
    .orderBy(desc(schema.auditLog.occurredAt))
    .limit(1);
  return prior ? (planTierOf(prior.after) ?? 'free') : 'free';
}

/** The tier before the earliest of this notice's own plan rows. None: it did not move. */
async function planBeforeChange(
  database: Database,
  notice: Pick<BillingNotice, 'familyId' | 'facts'>,
): Promise<BillingPlanName | null> {
  const [earliest] = await database
    .select({ before: schema.auditLog.before })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, notice.familyId),
        eq(schema.auditLog.actionTaken, 'family_plan_updated'),
        inArray(sql<string>`${schema.auditLog.after}->>'stripeEventId'`, notice.facts.eventIds),
      ),
    )
    .orderBy(asc(schema.auditLog.occurredAt))
    .limit(1);
  const tier = earliest ? planTierOf(earliest.before) : null;
  return tier ? (PLAN_NAME[tier] ?? null) : null;
}

function refundFacts(notice: Pick<BillingNotice, 'facts'>) {
  return (notice.facts.refunds ?? []).map((refund) => ({
    writer: {
      amount: billingDollars(refund.refundedMinor),
      of: billingDollars(refund.chargeMinor),
      full: refund.full,
    },
    claim: { refundedMinor: refund.refundedMinor, chargeMinor: refund.chargeMinor },
  }));
}

function subjectSubscriptions(notice: Pick<BillingNotice, 'facts'>): string[] {
  const ids = new Set<string>();
  if (notice.facts.ended) ids.add(notice.facts.ended.subscriptionId);
  for (const refund of notice.facts.refunds ?? []) {
    if (refund.subscriptionId) ids.add(refund.subscriptionId);
  }
  return [...ids];
}

export async function readNoticeFacts(
  database: Database,
  notice: BillingNotice & { parentUserId: string },
  deps: { subscriptions: NoticeSubscriptionReader | null; now: Date },
): Promise<NoticeFactsRead> {
  const [family] = await database
    .select({ planTier: schema.families.planTier })
    .from(schema.families)
    .where(eq(schema.families.id, notice.familyId))
    .limit(1);
  // billing_notices cascades with the family, so a row without one is a bug.
  if (!family) throw new Error('billing notice: no family row');
  const plan = PLAN_NAME[family.planTier];
  if (!plan) throw new Error('billing notice: unknown plan tier');
  const [language, clock] = await Promise.all([
    readParentLanguage(database, { familyId: notice.familyId, parentUserId: notice.parentUserId }),
    billingNoticeClock(database, notice.parentUserId),
  ]);
  const shared = { language, clock, plan };
  return notice.lane === 'payment'
    ? paymentFacts(database, notice, deps, shared)
    : planChangeFacts(database, notice, deps, shared);
}

interface SharedFacts {
  language: BillingNoticeFacts['language'];
  clock: ParentClock;
  plan: BillingPlanName;
}

async function paymentFacts(
  database: Database,
  notice: BillingNotice,
  deps: { subscriptions: NoticeSubscriptionReader | null },
  { language, clock, plan }: SharedFacts,
): Promise<NoticeFactsRead> {
  if (notice.facts.conflictingPayment) {
    return { status: 'drop', reason: 'duplicate_payment', page: true };
  }
  const subscriptionId = notice.facts.subscriptionId;
  if (!subscriptionId || !deps.subscriptions) {
    return { status: 'failed', reason: 'subscription_unread' };
  }
  let subscription: NoticeSubscription;
  try {
    subscription = await deps.subscriptions.read(subscriptionId);
  } catch (err) {
    console.warn(
      { err: err instanceof Error ? err.name : 'unknown' },
      'billing notice: subscription read failed',
    );
    return { status: 'failed', reason: 'subscription_unread' };
  }
  if (!subscription.createdAt) return { status: 'failed', reason: 'subscription_unread' };
  if (plan === 'Free') return { status: 'drop', reason: 'plan_not_paid', page: false };
  const sold = notice.facts.sessionTier ? PLAN_NAME[notice.facts.sessionTier] : null;
  if (plan !== sold) return { status: 'drop', reason: 'plan_mismatch', page: false };
  const before = await planBeforePurchase(database, notice.familyId, subscription.createdAt);
  if (before !== 'free') return { status: 'drop', reason: 'duplicate_payment', page: true };

  const through = paidThroughFor(subscription, clock);
  return {
    status: 'ready',
    writer: {
      happened: 'payment',
      language,
      plan,
      previousPlan: 'Free',
      ended: null,
      refunds: [],
      paidThrough: through ? { date: through.date, renews: through.renews } : null,
    },
    claim: {
      language,
      plan,
      previousPlan: 'Free',
      ended: false,
      refunds: [],
      paidThrough: through
        ? { date: through.date, year: through.year, month: through.month, day: through.day }
        : null,
    },
  };
}

async function planChangeFacts(
  database: Database,
  notice: BillingNotice,
  deps: { subscriptions: NoticeSubscriptionReader | null; now: Date },
  { language, clock, plan }: SharedFacts,
): Promise<NoticeFactsRead> {
  const moved = await planBeforeChange(database, notice);
  const previousPlan = moved === plan ? null : moved;
  const refunds = refundFacts(notice);
  const ended = notice.facts.ended;

  let through: PaidThrough | null = null;
  if (plan !== 'Free') {
    const subjects = subjectSubscriptions(notice);
    if (subjects.length > 0 && !deps.subscriptions) {
      return { status: 'failed', reason: 'subscription_unread' };
    }
    let reads: NoticeSubscription[] = [];
    try {
      reads = await Promise.all(
        subjects.map((id) => (deps.subscriptions as NoticeSubscriptionReader).read(id)),
      );
    } catch (err) {
      console.warn(
        { err: err instanceof Error ? err.name : 'unknown' },
        'billing notice: subscription read failed',
      );
      return { status: 'failed', reason: 'subscription_unread' };
    }
    // The refund's event can arrive before its cancel. "Still on Plus" about a
    // subscription Stripe already ended would be false, so the row waits for the deletion.
    if (
      refunds.length > 0 &&
      !ended &&
      reads.some((read) => read.status !== null && ENDED_STRIPE_STATUSES.has(read.status))
    ) {
      if (deps.now.getTime() - notice.createdAt.getTime() >= LAGGING_CANCEL_LIMIT_MS) {
        return { status: 'drop', reason: 'plan_state_unsettled', page: true };
      }
      return { status: 'wait', until: new Date(deps.now.getTime() + LAGGING_CANCEL_RETRY_MS) };
    }
    const [only, ...others] = reads;
    through = only && others.length === 0 ? paidThroughFor(only, clock) : null;
  }

  return {
    status: 'ready',
    writer: {
      happened: 'plan_change',
      language,
      plan,
      previousPlan,
      ended: ended ? { why: ended.why } : null,
      refunds: refunds.map((refund) => refund.writer),
      paidThrough: through ? { date: through.date, renews: through.renews } : null,
    },
    claim: {
      language,
      plan,
      previousPlan,
      ended: Boolean(ended),
      refunds: refunds.map((refund) => refund.claim),
      paidThrough: through
        ? { date: through.date, year: through.year, month: through.month, day: through.day }
        : null,
    },
  };
}
