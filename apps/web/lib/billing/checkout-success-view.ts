import { type Database, schema } from '@hale/db';
import type { PlanTier } from '@hale/types';
import { and, desc, eq, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { isUuid } from '~/lib/channel/mid-activity/claim';
import { firstName } from '~/lib/loop/reminders/group/standing';
import type { OpsPage, OpsPagerOutcome } from '~/lib/monitoring/failure-page';
import { familyIdFromStripeEvent } from '~/lib/webhooks/stripe-billing';
import { hasOneToOneThread, resolveCheckoutPayer } from './checkout-payer.js';

/**
 * Which state the checkout success page shows, from the Stripe session and Hale's DB.
 *
 * Whoever holds the success URL can read this answer, so two rules hold: family rows are
 * read only until the session's `expires_at`, and `firstName` / `checkInDue` exist only
 * on `plan_active`. `upgraded` and `already_on_plan` render on the page but nothing here
 * selects them: no billing flow charges "only the difference" or queues a duplicate's
 * refund, so their copy would be untrue today.
 */
export type CheckoutSuccessView =
  | { state: 'plan_active'; firstName: string | null; checkInDue: boolean }
  | { state: 'upgraded' }
  | { state: 'already_on_plan' }
  | { state: 'new_visitor' }
  | { state: 'pending' }
  | { state: 'under_review' }
  | { state: 'receipt' }
  | { state: 'not_paid' }
  | { state: 'unknown' };

export type CheckoutSuccessState = CheckoutSuccessView['state'];

export interface SessionFacts {
  id: string;
  status: 'open' | 'complete' | 'expired' | null;
  paymentStatus: string | null;
  tier: 'plus' | 'family' | null;
  /** now < session.expires_at. Family rows are read only while this holds. */
  fresh: boolean;
  createdAt: number;
  familyId: string | null;
  subscriptionId: string | null;
  subscriptionCreated: number | null;
  subscriptionStatus: string | null;
}

export interface FamilyFacts {
  familyId: string;
  planTier: PlanTier;
  /** The plan held before this subscription existed. */
  priorTier: PlanTier;
  /** A billing_refund_ready row names this subscription or session. */
  purchaseRefused: boolean;
  /** A paid family_plan_updated row landed since this subscription began. */
  grantLanded: boolean;
  payerId: string | null;
  payerHasThread: boolean;
}

export interface CheckoutViewDeps {
  database: () => Database;
  page: (database: Database, page: OpsPage) => Promise<OpsPagerOutcome>;
  env?: Record<string, string | undefined>;
  now?: Date;
}

/** The webhook's own set (stripe-billing-apply.ts). */
const LIVE_SUBSCRIPTION = new Set<string | null>(['active', 'trialing', 'past_due']);
/** Stripe's terminal states for a subscription whose payment never completed, plus a cancel. */
const ENDED_SUBSCRIPTION = new Set<string | null>(['canceled', 'incomplete_expired']);
/** Stops clock skew turning a real first purchase into a false duplicate. */
const PURCHASE_CLOCK_SKEW_SECONDS = 60;
const STRICT_UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sessionStatus(value: unknown): SessionFacts['status'] {
  return value === 'open' || value === 'complete' || value === 'expired' ? value : null;
}

export function sessionFactsFromStripe(
  session: unknown,
  tier: SessionFacts['tier'],
  now: Date,
): SessionFacts {
  const raw = isRecord(session) ? session : {};
  const expiresAt = readNumber(raw.expires_at);
  const subscription = isRecord(raw.subscription) ? raw.subscription : null;
  const familyId = familyIdFromStripeEvent({ data: { object: raw } });
  return {
    id: readString(raw.id) ?? '',
    status: sessionStatus(raw.status),
    paymentStatus: readString(raw.payment_status),
    tier,
    fresh: expiresAt !== null && now.getTime() < expiresAt * 1000,
    createdAt: readNumber(raw.created) ?? 0,
    familyId: familyId && isUuid(familyId) ? familyId : null,
    subscriptionId: subscription ? readString(subscription.id) : readString(raw.subscription),
    subscriptionCreated: subscription ? readNumber(subscription.created) : null,
    subscriptionStatus: subscription ? readString(subscription.status) : null,
  };
}

/** What Stripe alone settles. Null means the family decides. */
export function stripeDecidedState(
  s: SessionFacts,
): Exclude<CheckoutSuccessState, 'plan_active'> | null {
  if ((s.status === 'open' || s.status === 'expired') && s.paymentStatus !== 'paid') {
    return 'not_paid';
  }
  if (s.status !== 'complete') return 'unknown';
  if (!s.fresh) return s.paymentStatus === 'paid' ? 'receipt' : 'unknown';
  if (s.paymentStatus !== 'paid') {
    return ENDED_SUBSCRIPTION.has(s.subscriptionStatus) ? 'unknown' : 'pending';
  }
  return null;
}

/** `f` is null when there is no family id, the family is gone, or no subscription dates the purchase. */
export function familyDecidedState(s: SessionFacts, f: FamilyFacts | null): CheckoutSuccessState {
  if (f === null) return 'receipt';
  if (f.purchaseRefused || f.priorTier !== 'free') return 'under_review';
  if (f.planTier === 'free') {
    const inFlight = !f.grantLanded && LIVE_SUBSCRIPTION.has(s.subscriptionStatus);
    return inFlight ? 'pending' : 'receipt';
  }
  if (f.planTier !== s.tier) return 'receipt';
  return f.payerHasThread ? 'plan_active' : 'new_visitor';
}

function planTierOf(after: unknown): PlanTier | null {
  if (!isRecord(after)) return null;
  const tier = after.planTier;
  return tier === 'free' || tier === 'plus' || tier === 'family' ? tier : null;
}

/**
 * The newest plan row from before this subscription existed. A `free` row inside the
 * skew margin still counts: a drop to Free cannot be this purchase's own grant, and
 * without it a parent who cancels and buys again within a minute reads as a duplicate.
 */
async function priorPlanTier(
  database: Database,
  familyId: string,
  subscriptionCreated: number,
): Promise<PlanTier> {
  const created = new Date(subscriptionCreated * 1000);
  const cutoff = new Date((subscriptionCreated - PURCHASE_CLOCK_SKEW_SECONDS) * 1000);
  const [row] = await database
    .select({ after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'family_plan_updated'),
        or(
          lt(schema.auditLog.occurredAt, cutoff),
          and(
            lt(schema.auditLog.occurredAt, created),
            sql`${schema.auditLog.after}->>'planTier' = 'free'`,
          ),
        ),
      ),
    )
    .orderBy(desc(schema.auditLog.occurredAt))
    .limit(1);
  return planTierOf(row?.after) ?? 'free';
}

async function paidGrantLanded(
  database: Database,
  familyId: string,
  subscriptionCreated: number,
): Promise<boolean> {
  const cutoff = new Date((subscriptionCreated - PURCHASE_CLOCK_SKEW_SECONDS) * 1000);
  const [row] = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'family_plan_updated'),
        gte(schema.auditLog.occurredAt, cutoff),
        sql`${schema.auditLog.after}->>'planTier' in ('plus', 'family')`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function purchaseWasRefused(
  database: Database,
  familyId: string,
  s: SessionFacts,
): Promise<boolean> {
  const [row] = await database
    .select({ id: schema.auditLog.id })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        eq(schema.auditLog.actionTaken, 'billing_refund_ready'),
        or(
          sql`${schema.auditLog.after}->>'subscriptionId' = ${s.subscriptionId}`,
          sql`${schema.auditLog.after}->>'sessionId' = ${s.id}`,
        ),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function loadFamilyFacts(database: Database, s: SessionFacts): Promise<FamilyFacts | null> {
  if (s.familyId === null || s.subscriptionCreated === null) return null;
  const familyId = s.familyId;
  const [family] = await database
    .select({
      planTier: schema.families.planTier,
      linqGroupChatId: schema.families.linqGroupChatId,
    })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  if (!family) return null;
  const [priorTier, grantLanded, purchaseRefused, payerId] = await Promise.all([
    priorPlanTier(database, familyId, s.subscriptionCreated),
    paidGrantLanded(database, familyId, s.subscriptionCreated),
    purchaseWasRefused(database, familyId, s),
    resolveCheckoutPayer(database, familyId, s.createdAt),
  ]);
  const payerHasThread = payerId
    ? await hasOneToOneThread(database, payerId, family.linqGroupChatId)
    : false;
  return {
    familyId,
    planTier: family.planTier,
    priorTier,
    purchaseRefused,
    grantLanded,
    payerId,
    payerHasThread,
  };
}

/** The notices lane's armed check: the flag is exact `true` and SINCE is a real UTC instant. */
function billingNoticesArmedAt(env: Record<string, string | undefined>): Date | null {
  if (env.BILLING_THREAD_NOTICES_ENABLED !== 'true') return null;
  const raw = env.BILLING_THREAD_NOTICES_SINCE;
  if (raw === undefined || !STRICT_UTC_INSTANT.test(raw)) return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime())) return null;
  return at.toISOString().slice(0, 19) === raw.slice(0, 19) ? at : null;
}

/**
 * Whether the page may promise a check-in. Selects the channel's id only: the phone
 * stays encrypted on this public route.
 */
async function checkInIsDue(
  database: Database,
  s: SessionFacts,
  payerId: string,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const armedAt = billingNoticesArmedAt(env);
  if (armedAt === null || s.subscriptionCreated === null) return false;
  if (s.subscriptionCreated * 1000 <= armedAt.getTime()) return false;
  const [channel] = await database
    .select({ id: schema.parentChannels.id })
    .from(schema.parentChannels)
    .where(
      and(
        eq(schema.parentChannels.userId, payerId),
        eq(schema.parentChannels.kind, 'sms'),
        isNotNull(schema.parentChannels.verifiedAt),
        isNull(schema.parentChannels.revokedAt),
      ),
    )
    .limit(1);
  return channel !== undefined;
}

async function payerFirstName(database: Database, payerId: string): Promise<string | null> {
  const [user] = await database
    .select({ name: schema.users.name })
    .from(schema.users)
    .where(eq(schema.users.id, payerId))
    .limit(1);
  return firstName(user?.name);
}

async function familyView(
  database: Database,
  s: SessionFacts,
  deps: CheckoutViewDeps,
): Promise<CheckoutSuccessView> {
  const family = await loadFamilyFacts(database, s);
  const state = familyDecidedState(s, family);
  if (state === 'under_review' && family && !family.purchaseRefused) {
    await deps.page(database, {
      site: 'checkout_duplicate_payment',
      facts: { transition: family.priorTier === s.tier ? 'same_plan' : 'other_plan' },
      ref: family.familyId,
    });
  }
  if (state !== 'plan_active') return { state };
  const payerId = family?.payerId ?? null;
  if (payerId === null) return { state, firstName: null, checkInDue: false };
  const [name, checkInDue] = await Promise.all([
    payerFirstName(database, payerId),
    checkInIsDue(database, s, payerId, deps.env ?? process.env),
  ]);
  return { state, firstName: name, checkInDue };
}

/**
 * The view for one retrieved session. Stripe settles what it can before any family row
 * is read, so an open, expired or past-window session can never reach a family read and
 * a DB failure can never turn one into `pending`. Only a session Stripe says is paid
 * reaches the catch; it stays `pending` because the page's poll retries the read.
 */
export async function checkoutViewFromSession(
  session: unknown,
  tier: SessionFacts['tier'],
  deps: CheckoutViewDeps,
): Promise<CheckoutSuccessView> {
  const facts = sessionFactsFromStripe(session, tier, deps.now ?? new Date());
  const decided = stripeDecidedState(facts);
  if (decided) return { state: decided };
  try {
    return await familyView(deps.database(), facts, deps);
  } catch (err) {
    console.warn('checkout view: family read failed', {
      err: err instanceof Error ? err.name : 'unknown',
    });
    return { state: 'pending' };
  }
}
