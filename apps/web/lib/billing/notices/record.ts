import { createHash } from 'node:crypto';
import {
  type BillingNoticeEventFacts,
  type BillingNoticeLane,
  type Database,
  schema,
} from '@hale/db';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { billingThreadNoticesArmedAt } from '~/lib/billing/flags';
import type { OpsPager } from '~/lib/monitoring/failure-page';
import { isPreviewDeploy } from '~/lib/preview/family-scope';
import { familyIdFromStripeEvent, stripeRefsFromStripeEvent } from '~/lib/webhooks/stripe-billing';
import type { ApplyStripeBillingResult } from '~/lib/webhooks/stripe-billing-apply';
import { addsNoticeSubject, mergeNoticeFacts } from './merge';
import { BILLING_NOTICE_LOCK_NS, writeNoticeAudit } from './store';

/**
 * VIL-735 · the webhook's half of a billing notice: one durable row saying a text is
 * owed. No model call, no send and no Stripe call happen here, and a dark flag returns
 * before any query, so the route behaves exactly as it did.
 *
 * Apply's status alone does not prove the money moved: every second delivery answers
 * `duplicate` whatever the first did, so a duplicate records only when this event's own
 * audit row shows a grant or a kept refund.
 */

export type BillingNoticeRecordOutcome =
  | 'dark'
  | 'preview'
  | 'not_a_notice_event'
  | 'test_mode'
  | 'before_arm'
  | 'stale_event'
  | 'not_paid'
  | 'no_family'
  | 'not_applied'
  | 'duplicate'
  | 'stale_refund'
  | 'recorded';

const NOTICE_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.deleted',
  'charge.refunded',
] as const;
type NoticeEventType = (typeof NOTICE_EVENT_TYPES)[number];

/** Stripe retries for three days; a Dashboard or CLI resend can be far older. */
const MAX_EVENT_AGE_MS = 72 * 3_600_000;
/** Debounce, so a refund and a cancel seconds apart are one text. Not a send rule. */
const SETTLE_MS = 10 * 60_000;
/** Measured from Hale's own `created_at`, so a run of refunds cannot delay it forever. */
const SETTLE_CEILING_MS = 60 * 60_000;

/** Verbs that carry `after.stripeEventId` and say what the first delivery did. */
const OUTCOME_VERBS = [
  'family_plan_updated',
  'billing_refunded',
  'billing_revoke_unresolved',
  'billing_grant_blocked',
  'billing_refund_ready',
] as const;

const PROVING_VERBS: Record<NoticeEventType, readonly string[]> = {
  'checkout.session.completed': ['family_plan_updated'],
  'customer.subscription.deleted': ['family_plan_updated'],
  'charge.refunded': ['family_plan_updated', 'billing_refunded'],
};

const RECORDING_STATUSES: Record<NoticeEventType, readonly ApplyStripeBillingResult['status'][]> = {
  'checkout.session.completed': ['applied'],
  'customer.subscription.deleted': ['applied'],
  'charge.refunded': ['applied', 'kept', 'no_tier'],
};

interface NoticeEvent {
  id: string;
  type: NoticeEventType;
  livemode: unknown;
  createdAt: Date | null;
  object: Record<string, unknown>;
  objectId: string;
}

export interface RecordNoticeDeps {
  env?: Record<string, string | undefined>;
  now?: Date;
  pager?: OpsPager;
}

function defaultPager(database: Database): OpsPager {
  return {
    async page(page) {
      const { pageOps } = await import('~/lib/monitoring/failure-page');
      return pageOps(database, page);
    },
  };
}

export async function recordBillingNoticeIntent(
  database: Database,
  event: unknown,
  applied: ApplyStripeBillingResult,
  deps: RecordNoticeDeps = {},
): Promise<BillingNoticeRecordOutcome> {
  const env = deps.env ?? process.env;
  const armedAt = billingThreadNoticesArmedAt(env);
  if (armedAt === null) return 'dark';
  const outcome = await recordArmed(database, event, applied, armedAt, deps, env);
  console.info({ event: 'billing_notice_record', outcome }, 'billing notice: webhook');
  return outcome;
}

async function recordArmed(
  database: Database,
  rawEvent: unknown,
  applied: ApplyStripeBillingResult,
  armedAt: Date,
  deps: RecordNoticeDeps,
  env: Record<string, string | undefined>,
): Promise<BillingNoticeRecordOutcome> {
  if (isPreviewDeploy(env)) return 'preview';
  const event = readNoticeEvent(rawEvent);
  if (!event) return 'not_a_notice_event';
  if (event.livemode !== true) return 'test_mode';
  if (event.createdAt === null || event.createdAt.getTime() <= armedAt.getTime()) {
    return 'before_arm';
  }
  const now = deps.now ?? new Date();
  if (now.getTime() - event.createdAt.getTime() > MAX_EVENT_AGE_MS) return 'stale_event';
  if (event.type === 'checkout.session.completed' && !sessionPaid(event.object)) return 'not_paid';

  const familyId = await familyFor(database, rawEvent, event);
  if (!familyId) return 'no_family';

  const lane = laneOf(event.type);
  try {
    const proven = await provenTier(database, familyId, event, applied);
    if (proven === 'not_applied') return 'not_applied';
    const incoming = incomingFacts(event, proven.tier);
    if (incoming === null) return 'not_applied';
    return await database.transaction((tx) =>
      writeIntent(tx, { familyId, lane, event, incoming, now, armedAt }),
    );
  } catch (err) {
    const pager = deps.pager ?? defaultPager(database);
    await pager
      .page({
        site: 'billing_notice_unsent',
        ref: familyId,
        facts: { lane, reason: 'unrecorded' },
      })
      .catch((pageErr: unknown) => {
        console.error(
          { err: pageErr instanceof Error ? pageErr.name : 'unknown' },
          'billing notice: could not page an unrecorded intent',
        );
      });
    throw err;
  }
}

function laneOf(type: NoticeEventType): BillingNoticeLane {
  return type === 'checkout.session.completed' ? 'payment' : 'plan_change';
}

function readNoticeEvent(event: unknown): NoticeEvent | null {
  if (!isRecord(event)) return null;
  const type = NOTICE_EVENT_TYPES.find((candidate) => candidate === event.type);
  const id = readString(event.id);
  const object = isRecord(event.data) ? event.data.object : undefined;
  if (!type || !id || !isRecord(object)) return null;
  const objectId = readString(object.id);
  if (!objectId) return null;
  const created = event.created;
  return {
    id,
    type,
    livemode: event.livemode,
    createdAt:
      typeof created === 'number' && Number.isFinite(created) && created > 0
        ? new Date(created * 1000)
        : null,
    object,
    objectId,
  };
}

/** The rule at billing/conversions.ts: an absent status is a paid session. */
function sessionPaid(session: Record<string, unknown>): boolean {
  const status = readString(session.payment_status);
  return !status || status === 'paid' || status === 'no_payment_required';
}

/**
 * Checkout and subscription objects carry the family id. A real refund's charge does not,
 * so it falls back to the unique Stripe customer. Checked against the table because an
 * event naming an unknown family was still claimed by apply, and its redelivery would
 * otherwise throw on the foreign key forever.
 */
async function familyFor(
  database: Database,
  rawEvent: unknown,
  event: NoticeEvent,
): Promise<string | null> {
  const named = familyIdFromStripeEvent(rawEvent);
  if (named) {
    const [row] = await database
      .select({ id: schema.families.id })
      .from(schema.families)
      .where(eq(schema.families.id, named))
      .limit(1);
    return row?.id ?? null;
  }
  if (event.type !== 'charge.refunded') return null;
  const { customerId } = stripeRefsFromStripeEvent(rawEvent);
  if (!customerId) return null;
  const [row] = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(eq(schema.families.stripeCustomerId, customerId))
    .limit(1);
  return row?.id ?? null;
}

async function provenTier(
  database: Database,
  familyId: string,
  event: NoticeEvent,
  applied: ApplyStripeBillingResult,
): Promise<{ tier: string | null } | 'not_applied'> {
  if (RECORDING_STATUSES[event.type].includes(applied.status)) {
    return { tier: applied.status === 'applied' ? applied.tier : null };
  }
  if (applied.status !== 'duplicate') return 'not_applied';
  const rows = await database
    .select({ actionTaken: schema.auditLog.actionTaken, after: schema.auditLog.after })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        inArray(schema.auditLog.actionTaken, [...OUTCOME_VERBS]),
        sql`${schema.auditLog.after}->>'stripeEventId' = ${event.id}`,
      ),
    );
  const proving = PROVING_VERBS[event.type];
  if (rows.length === 0 || rows.some((row) => !proving.includes(row.actionTaken))) {
    return 'not_applied';
  }
  const after = rows[0]?.after;
  return { tier: isRecord(after) ? readString(after.planTier) : null };
}

function incomingFacts(event: NoticeEvent, tier: string | null): BillingNoticeEventFacts | null {
  const { object } = event;
  if (event.type === 'checkout.session.completed') {
    if (tier !== 'plus' && tier !== 'family') return null;
    const created = object.created;
    const sessionCreated =
      typeof created === 'number' && Number.isFinite(created) && created > 0
        ? new Date(created * 1000)
        : event.createdAt;
    const subscriptionId = readId(object.subscription);
    return {
      eventIds: [event.id],
      sessionCreatedAt: (sessionCreated as Date).toISOString(),
      sessionTier: tier,
      ...(subscriptionId ? { subscriptionId } : {}),
    };
  }
  if (event.type === 'customer.subscription.deleted') {
    return {
      eventIds: [event.id],
      ended: { subscriptionId: event.objectId, why: endedWhy(object) },
    };
  }
  const refundedMinor = object.amount_refunded;
  const chargeMinor = object.amount;
  const currency = readString(object.currency);
  if (typeof refundedMinor !== 'number' || typeof chargeMinor !== 'number' || !currency) {
    return null;
  }
  return {
    eventIds: [event.id],
    refunds: [
      {
        chargeId: event.objectId,
        refundedMinor,
        chargeMinor,
        currency,
        full: object.refunded === true || refundedMinor >= chargeMinor,
      },
    ],
  };
}

/** A dispute is deliberately neither, so the text never brings one up. */
function endedWhy(subscription: Record<string, unknown>): 'cancelled' | 'payment_failed' | null {
  const details = isRecord(subscription.cancellation_details)
    ? subscription.cancellation_details
    : null;
  const reason = details ? readString(details.reason) : null;
  if (reason === 'cancellation_requested') return 'cancelled';
  if (reason === 'payment_failed') return 'payment_failed';
  return null;
}

/**
 * The notice key is the type and the object (Stripe can send two Event objects for one
 * change), plus the refunded total, because two partial refunds on one charge are two
 * real events about one object. Hashed: this table is outside family erasure.
 */
function noticeClaimKey(event: NoticeEvent): string {
  const total = event.type === 'charge.refunded' ? String(event.object.amount_refunded) : '';
  const digest = createHash('sha256')
    .update(`${event.type}|${event.objectId}|${total}`)
    .digest('hex');
  return `notice:${digest}`;
}

async function writeIntent(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  input: {
    familyId: string;
    lane: BillingNoticeLane;
    event: NoticeEvent;
    incoming: BillingNoticeEventFacts;
    now: Date;
    armedAt: Date;
  },
): Promise<BillingNoticeRecordOutcome> {
  const { familyId, lane, event, incoming, now, armedAt } = input;
  await tx.execute(
    sql`select pg_advisory_xact_lock(${BILLING_NOTICE_LOCK_NS}::int, hashtext(${familyId}))`,
  );
  const claim = await tx
    .insert(schema.stripeBillingEvents)
    .values({ eventId: noticeClaimKey(event) })
    .onConflictDoNothing()
    .returning({ id: schema.stripeBillingEvents.id });
  if (claim.length === 0) return 'duplicate';

  if (await refundAlreadyTold(tx, familyId, incoming)) return 'stale_refund';

  const eventAt = event.createdAt as Date;
  const [held] = await tx
    .select()
    .from(schema.billingNotices)
    .where(
      and(
        eq(schema.billingNotices.familyId, familyId),
        eq(schema.billingNotices.lane, lane),
        eq(schema.billingNotices.status, 'open'),
      ),
    )
    .limit(1);
  let open = held;
  // A row from before the current arming must not ride a new event past the leg's check.
  if (open && open.lastEventAt.getTime() <= armedAt.getTime()) {
    await tx
      .update(schema.billingNotices)
      .set({ status: 'dropped', dropReason: 'before_arm', updatedAt: now })
      .where(eq(schema.billingNotices.id, open.id));
    await writeNoticeAudit(tx, open, 'billing_notice_dropped', {
      reason: 'before_arm',
      attempts: open.attempts,
    });
    open = undefined;
  }

  if (!open) {
    await tx.insert(schema.billingNotices).values({
      familyId,
      lane,
      facts: incoming,
      lastEventAt: eventAt,
      nextTryAt: lane === 'payment' ? now : new Date(now.getTime() + SETTLE_MS),
      createdAt: now,
      updatedAt: now,
    });
    return 'recorded';
  }

  await tx
    .update(schema.billingNotices)
    .set({
      facts: mergeNoticeFacts(open.facts, incoming),
      lastEventAt: eventAt > open.lastEventAt ? eventAt : open.lastEventAt,
      nextTryAt:
        lane === 'payment'
          ? now
          : new Date(
              Math.min(now.getTime() + SETTLE_MS, open.createdAt.getTime() + SETTLE_CEILING_MS),
            ),
      parentUserId: addsNoticeSubject(open.facts, incoming) ? null : open.parentUserId,
      updatedAt: now,
    })
    .where(eq(schema.billingNotices.id, open.id));
  return 'recorded';
}

/** An older refund event cannot lower a total Hale already told the parent. */
async function refundAlreadyTold(
  tx: Parameters<Parameters<Database['transaction']>[0]>[0],
  familyId: string,
  incoming: BillingNoticeEventFacts,
): Promise<boolean> {
  const refund = incoming.refunds?.[0];
  if (!refund) return false;
  const told = await tx
    .select({ facts: schema.billingNotices.facts })
    .from(schema.billingNotices)
    .where(
      and(
        eq(schema.billingNotices.familyId, familyId),
        eq(schema.billingNotices.lane, 'plan_change'),
        inArray(schema.billingNotices.status, ['sending', 'sent']),
      ),
    );
  return told.some((row) =>
    (row.facts.refunds ?? []).some(
      (seen) => seen.chargeId === refund.chargeId && refund.refundedMinor <= seen.refundedMinor,
    ),
  );
}

function readId(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (isRecord(value)) return readString(value.id);
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
