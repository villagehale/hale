import { type BillingNotice, type BillingNoticeEventFacts, type Database, schema } from '@hale/db';
import { and, asc, eq, gte, inArray, lte, ne, sql } from 'drizzle-orm';
import { recordAgentRun } from '~/lib/agent-run';
import { billingThreadNoticesArmedAt } from '~/lib/billing/flags';
import {
  type StripeChargeLookup,
  stripeChargeLookupFromEnv,
} from '~/lib/billing/stripe-charge-context';
import { productionChannels } from '~/lib/channel/adapters/production';
import {
  ChannelRetryableError,
  type DispatchResult,
  dispatchLoopMessage,
} from '~/lib/channel/dispatch';
import { SENT_STATUSES } from '~/lib/channel/ledger';
import { linqFromE164 } from '~/lib/channel/linq/config';
import { LinqSendError, findLinqDirectChat } from '~/lib/channel/linq/transport';
import { assertProactiveSendAllowed, buildOutboundGatePorts } from '~/lib/channel/outbound-gate';
import type { BillingClaimFacts } from '~/lib/channel/reconcile/billing-text';
import type { LoopMessage } from '~/lib/channel/types';
import { buildDispatchPorts } from '~/lib/channel/wiring';
import { nextComposeHold } from '~/lib/loop/reminders/schedule';
import { categoryEnabled, deliverableNow, loadLoopPrefsView } from '~/lib/loop/prefs';
import { BILLING_NOTICE_TEMPLATE_KEY } from '~/lib/loop/templates/billing-notice';
import { loopTemplateRenderer } from '~/lib/loop/templates/registry';
import { voiceClient } from '~/lib/loop/voice/compose';
import { type OpsPage, type OpsPager, failurePageOpsPager } from '~/lib/monitoring/failure-page';
import { isPreviewDeploy } from '~/lib/preview/family-scope';
import {
  type BillingNoticeCompose,
  type BillingNoticeFacts,
  composeBillingNotice,
} from './compose';
import { billingNoticeClock, readNoticeFacts } from './facts';
import { addsNoticeSubject, mergeNoticeFacts } from './merge';
import { confirmPayerSeat, resolveNoticePayer } from './payer';
import { BILLING_NOTICE_LOCK_NS, writeNoticeAudit } from './store';
import {
  type NoticeSubscriptionReader,
  stripeSubscriptionReaderFromEnv,
} from './subscription-read';
import { payerThreadProof } from './thread';

/**
 * VIL-735 · the drain's half of a billing notice. A due row is checked against every gate
 * BEFORE any model call, so a text waiting for morning costs nothing and can still absorb
 * a refund that lands overnight. Then the row closes, the facts are read, the model
 * writes, and the dispatch sends. A row is `sent` only on a ledger row Linq accepted
 * (the #1324 rule); anything else retries with a fresh write, then pages #ops. Nothing
 * is ever sent in place of the model's text.
 */

const DUE_BATCH = 25;
/** Longer than one notice's model calls plus its send. */
const SEND_LEASE_MS = 10 * 60_000;
const MAX_NOTICE_AGE_MS = 72 * 3_600_000;
const DUPLICATE_REVIEW_MS = 30 * 86_400_000;
/** A receipt answers what the parent just did only while the payment is this fresh. */
export const BILLING_RECEIPT_FRESH_MS = 15 * 60_000;
const PAUSED_RETRY_MS = 15 * 60_000;
const OPT_OUT_RETRY_MS = 60 * 60_000;
const QUIET_RETRY_MS = 30 * 60_000;

/** The route's ceiling is 800s and the queues may use 700. No notice starts past this. */
const LAST_START_MS = 640_000;
/** Every model call of a notice runs under one signal that fires here. */
const MODEL_DEADLINE_MS = 740_000;
/** How long the leg keeps taking new rows, so it cannot crowd the rest of the tick. */
const LEG_TAKE_MS = 45_000;

type NoticeFailure =
  | 'unwritten'
  | 'fact_check'
  | 'claim_gate'
  | 'send_refused'
  | 'send_abandoned'
  | 'not_confirmed'
  | 'subscription_unread'
  | 'thread_unread'
  | 'unexpected';

type DropReason =
  | 'before_arm'
  | 'stale'
  | 'erasure_scheduled'
  | 'duplicate_under_review'
  | 'duplicate_payment'
  | 'payer_unresolved'
  | 'recipient_gone'
  | 'no_thread'
  | 'no_consent'
  | 'category_off'
  | 'plan_not_paid'
  | 'plan_mismatch'
  | 'plan_state_unsettled'
  | 'merged'
  | 'send_retries_exhausted';

/** The drops ops has to act on. The rest are ordinary states. */
const PAGED_DROPS = [
  'stale',
  'duplicate_under_review',
  'duplicate_payment',
  'payer_unresolved',
  'plan_state_unsettled',
] as const satisfies readonly DropReason[];
type PagedDrop = (typeof PAGED_DROPS)[number];

function isPagedDrop(reason: DropReason): reason is PagedDrop {
  return (PAGED_DROPS as readonly string[]).includes(reason);
}

export interface BillingNoticeRunDeps {
  env: Record<string, string | undefined>;
  now: () => Date;
  /** When this drain run started, in milliseconds. */
  runStartedAt: number;
  pager: OpsPager;
  subscriptions: NoticeSubscriptionReader | null;
  charges: StripeChargeLookup | null;
  findDirectChat: (phone: string) => Promise<string | null>;
  compose: (input: {
    facts: BillingNoticeFacts;
    claimFacts: BillingClaimFacts;
    familyId: string;
    signal: AbortSignal;
  }) => Promise<BillingNoticeCompose>;
  dispatch: (message: LoopMessage) => Promise<DispatchResult>;
}

export interface BillingNoticeTick {
  due: number;
  sent: number;
  held: number;
  retrying: number;
  dropped: number;
  skipped: number;
  stopped: 'budget' | null;
}

export type BillingNoticeTickResult = BillingNoticeTick | { skipped: 'flag_off' | 'preview' };

type RowOutcome = 'sent' | 'held' | 'retrying' | 'dropped' | 'skipped';

export function defaultBillingNoticeDeps(
  database: Database,
  runStartedAt: number,
): BillingNoticeRunDeps {
  const ports = buildDispatchPorts(database, {
    channels: productionChannels(database),
    renderer: loopTemplateRenderer,
  });
  return {
    env: process.env,
    now: () => new Date(),
    runStartedAt,
    pager: failurePageOpsPager(() => database),
    subscriptions: stripeSubscriptionReaderFromEnv(),
    charges: stripeChargeLookupFromEnv(),
    findDirectChat: async (phone) => {
      const from = linqFromE164();
      if (!from) throw new LinqSendError('not_configured', 0, true);
      return findLinqDirectChat({ from, to: phone });
    },
    compose: ({ facts, claimFacts, familyId, signal }) =>
      composeBillingNotice({
        client: voiceClient(),
        facts,
        claimFacts,
        familyId,
        signal,
        recordRun: async (run) => {
          await recordAgentRun(database, run);
        },
      }),
    dispatch: (message) => dispatchLoopMessage(message, ports),
  };
}

export async function runBillingNoticeTick(
  database: Database,
  deps: BillingNoticeRunDeps,
): Promise<BillingNoticeTickResult> {
  const armedAt = billingThreadNoticesArmedAt(deps.env);
  if (armedAt === null) return { skipped: 'flag_off' };
  if (isPreviewDeploy(deps.env)) return { skipped: 'preview' };

  const tickStartedAt = deps.now().getTime();
  const due = await database
    .select()
    .from(schema.billingNotices)
    .where(
      and(
        inArray(schema.billingNotices.status, ['open', 'sending']),
        lte(schema.billingNotices.nextTryAt, deps.now()),
      ),
    )
    .orderBy(asc(schema.billingNotices.nextTryAt))
    .limit(DUE_BATCH);

  const tick: BillingNoticeTick = {
    due: due.length,
    sent: 0,
    held: 0,
    retrying: 0,
    dropped: 0,
    skipped: 0,
    stopped: null,
  };
  for (const row of due) {
    const at = deps.now().getTime();
    if (at - deps.runStartedAt > LAST_START_MS || at - tickStartedAt > LEG_TAKE_MS) {
      tick.stopped = 'budget';
      break;
    }
    try {
      tick[await processNotice(database, row, armedAt, deps)] += 1;
    } catch (err) {
      // One family's failure must not cost the next family its text. Counted as an
      // attempt, so a row that always throws ends in a page rather than a silent loop.
      console.error(
        { err: err instanceof Error ? err.name : 'unknown', notice: row.id },
        'billing notice: row failed',
      );
      tick[await failAttempt(database, row, 'unexpected', deps)] += 1;
    }
  }
  return tick;
}

async function processNotice(
  database: Database,
  row: BillingNotice,
  armedAt: Date,
  deps: BillingNoticeRunDeps,
): Promise<RowOutcome> {
  if (row.status === 'sending') return takeOver(database, row, deps);
  const now = deps.now();

  if (row.lastEventAt.getTime() <= armedAt.getTime()) {
    return dropNotice(database, row, 'before_arm', deps);
  }
  if (now.getTime() - row.lastEventAt.getTime() > MAX_NOTICE_AGE_MS) {
    return dropNotice(database, row, 'stale', deps);
  }
  const [family] = await database
    .select({ scheduledDeletionAt: schema.families.scheduledDeletionAt })
    .from(schema.families)
    .where(eq(schema.families.id, row.familyId))
    .limit(1);
  if (!family || family.scheduledDeletionAt !== null) {
    return dropNotice(database, row, 'erasure_scheduled', deps);
  }
  if (row.lane === 'plan_change' && (await duplicateUnderReview(database, row, now))) {
    return dropNotice(database, row, 'duplicate_under_review', deps);
  }

  const resolvedFacts = await withRefundSubscriptions(row.facts, deps.charges);
  if (resolvedFacts === null) return failAttempt(database, row, 'subscription_unread', deps);

  const payer = row.parentUserId
    ? await confirmPayerSeat(database, row.familyId, row.parentUserId)
    : await resolveNoticePayer(database, { ...row, facts: resolvedFacts });
  if (payer.status !== 'resolved') return dropNotice(database, row, payer.status, deps);
  const { parentUserId } = payer;

  const gate = await sendGates(database, row, parentUserId, now);
  if (gate.kind === 'drop') return dropNotice(database, row, gate.reason, deps);
  if (gate.kind === 'wait') return waitOpen(database, row, gate.until, now);

  const proof = await payerThreadProof(database, parentUserId, {
    before:
      row.lane === 'payment' && row.facts.sessionCreatedAt
        ? new Date(row.facts.sessionCreatedAt)
        : null,
    findDirectChat: deps.findDirectChat,
  });
  if (proof === 'no_thread') return dropNotice(database, row, 'no_thread', deps);
  if (proof === 'unread') return failAttempt(database, row, 'thread_unread', deps);

  const closed = await closeRow(database, row, parentUserId, resolvedFacts, deps);
  if (!closed) return 'skipped';
  return writeAndSend(database, { ...closed, parentUserId }, deps);
}

async function writeAndSend(
  database: Database,
  row: BillingNotice & { parentUserId: string },
  deps: BillingNoticeRunDeps,
): Promise<RowOutcome> {
  const facts = await readNoticeFacts(database, row, {
    subscriptions: deps.subscriptions,
    now: deps.now(),
  });
  if (facts.status === 'drop') return dropNotice(database, row, facts.reason, deps);
  if (facts.status === 'wait') {
    await returnToOpen(database, row, { nextTryAt: facts.until, attempts: row.attempts }, deps);
    return 'held';
  }
  if (facts.status === 'failed') return failAttempt(database, row, facts.reason, deps);

  const deadline = Math.max(0, deps.runStartedAt + MODEL_DEADLINE_MS - deps.now().getTime());
  const written = await deps.compose({
    facts: facts.writer,
    claimFacts: facts.claim,
    familyId: row.familyId,
    signal: AbortSignal.timeout(deadline),
  });
  if (written.status === 'failed') return failAttempt(database, row, written.reason, deps);

  // Writing can take minutes, and an opt-out hold can land in that time. The dispatch
  // re-reads consent but not the hold.
  const now = deps.now();
  const gate = await sendGates(database, row, row.parentUserId, now);
  if (gate.kind === 'drop') return dropNotice(database, row, gate.reason, deps);
  if (gate.kind === 'wait') {
    await returnToOpen(database, row, { nextTryAt: gate.until, attempts: row.attempts }, deps);
    return 'held';
  }

  const message: LoopMessage = {
    templateKey: BILLING_NOTICE_TEMPLATE_KEY,
    familyId: row.familyId,
    parentUserId: row.parentUserId,
    category: 'alert',
    urgency: gate.fresh ? 'time_sensitive' : 'normal',
    payload: { text: written.text },
    dedupeKey: noticeDedupeKey(row.id),
    claimFacts: facts.claim,
  };
  let result: DispatchResult;
  try {
    result = await deps.dispatch(message);
  } catch (err) {
    // A throw after Linq accepted (the thread write, say) is still a text they received.
    if (await settleIfAccepted(database, row, deps)) return 'sent';
    if (err instanceof ChannelRetryableError) {
      return failAttempt(database, row, failureOf(err.code), deps);
    }
    throw err;
  }
  return settleDispatch(database, row, result, deps);
}

function noticeDedupeKey(id: string): string {
  return `${BILLING_NOTICE_TEMPLATE_KEY}:${id}`;
}

/** The closed list the audit row and the page may carry, never a provider's own code. */
function failureOf(code: string): NoticeFailure {
  return code === 'unbacked_claim' || code === 'claim_read_failed' ? 'claim_gate' : 'send_refused';
}

async function settleDispatch(
  database: Database,
  row: BillingNotice & { parentUserId: string },
  result: DispatchResult,
  deps: BillingNoticeRunDeps,
): Promise<RowOutcome> {
  const leg = result.legs[0];
  if (!leg) return failAttempt(database, row, 'not_confirmed', deps);
  switch (leg.outcome) {
    case 'sent':
    case 'deduped':
      if (await settleIfAccepted(database, row, deps)) return 'sent';
      return failAttempt(database, row, 'not_confirmed', deps);
    case 'suppressed_quiet_hours':
      await returnToOpen(
        database,
        row,
        {
          nextTryAt: new Date(deps.now().getTime() + QUIET_RETRY_MS),
          attempts: row.attempts,
        },
        deps,
      );
      return 'held';
    case 'suppressed_pref':
      return dropNotice(database, row, 'category_off', deps);
    case 'suppressed_consent':
      return dropNotice(database, row, 'no_consent', deps);
    case 'failed':
      return failAttempt(database, row, failureOf(leg.reason ?? 'unknown'), deps);
    case 'suppressed_cap':
      return failAttempt(database, row, 'send_refused', deps);
  }
}

/** The ledger row Linq accepted for this notice: written only from Linq's own answer. */
async function acceptedLedgerRow(database: Database, id: string): Promise<{ id: string } | null> {
  const [row] = await database
    .select({ id: schema.channelMessages.id })
    .from(schema.channelMessages)
    .where(
      and(
        eq(schema.channelMessages.dedupeKey, `${noticeDedupeKey(id)}:sms`),
        inArray(schema.channelMessages.status, [...SENT_STATUSES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function settleIfAccepted(
  database: Database,
  row: BillingNotice,
  deps: BillingNoticeRunDeps,
): Promise<boolean> {
  const accepted = await acceptedLedgerRow(database, row.id);
  if (!accepted) return false;
  await database.transaction(async (tx) => {
    const settled = await tx
      .update(schema.billingNotices)
      .set({
        status: 'sent',
        channelMessageId: accepted.id,
        updatedAt: deps.now(),
      })
      .where(and(eq(schema.billingNotices.id, row.id), eq(schema.billingNotices.status, 'sending')))
      .returning({ id: schema.billingNotices.id });
    if (settled.length > 0) {
      await writeNoticeAudit.sent(tx, row, { attempts: row.attempts });
    }
  });
  return true;
}

/**
 * A `sending` row past its lease. The ledger is read FIRST: a text Linq accepted is final,
 * so a crash after the accept settles as sent with no truth check, no model call and no
 * second text, even if the plan has moved since.
 */
async function takeOver(
  database: Database,
  row: BillingNotice,
  deps: BillingNoticeRunDeps,
): Promise<RowOutcome> {
  const now = deps.now();
  const [claimed] = await database
    .update(schema.billingNotices)
    .set({ nextTryAt: new Date(now.getTime() + SEND_LEASE_MS), updatedAt: now })
    .where(
      and(
        eq(schema.billingNotices.id, row.id),
        eq(schema.billingNotices.status, 'sending'),
        lte(schema.billingNotices.nextTryAt, now),
      ),
    )
    .returning();
  if (!claimed) return 'skipped';
  if (await settleIfAccepted(database, claimed, deps)) return 'sent';
  return failAttempt(database, claimed, 'send_abandoned', deps);
}

async function duplicateUnderReview(
  database: Database,
  row: BillingNotice,
  now: Date,
): Promise<boolean> {
  const [found] = await database
    .select({ id: schema.billingNotices.id })
    .from(schema.billingNotices)
    .where(
      and(
        eq(schema.billingNotices.familyId, row.familyId),
        eq(schema.billingNotices.status, 'dropped'),
        eq(schema.billingNotices.dropReason, 'duplicate_payment'),
        gte(schema.billingNotices.updatedAt, new Date(now.getTime() - DUPLICATE_REVIEW_MS)),
      ),
    )
    .limit(1);
  return found !== undefined;
}

/**
 * Each refund's subscription, looked up once: a charge event does not carry it. Null when
 * a lookup failed, which is a failed attempt rather than a guess at who it was for.
 */
async function withRefundSubscriptions(
  facts: BillingNoticeEventFacts,
  charges: StripeChargeLookup | null,
): Promise<BillingNoticeEventFacts | null> {
  const refunds = facts.refunds ?? [];
  if (refunds.every((refund) => refund.subscriptionId !== undefined)) return facts;
  if (!charges) return null;
  try {
    const resolved = await Promise.all(
      refunds.map(async (refund) =>
        refund.subscriptionId !== undefined
          ? refund
          : {
              ...refund,
              subscriptionId: (await charges.lookupCharge(refund.chargeId)).subscriptionId,
            },
      ),
    );
    return { ...facts, refunds: resolved };
  } catch (err) {
    console.warn(
      { err: err instanceof Error ? err.name : 'unknown' },
      'billing notice: charge lookup failed',
    );
    return null;
  }
}

type GateVerdict =
  | { kind: 'pass'; fresh: boolean }
  | { kind: 'wait'; until: Date }
  | { kind: 'drop'; reason: 'no_consent' | 'category_off' };

/**
 * The checks that may stop this text. They run before the model is called, and again
 * right before the send. A receipt does not need the `proactive_watch` consent (a parent
 * who declined the radar still bought a plan), and the clock is this lane's own.
 */
async function sendGates(
  database: Database,
  row: BillingNotice,
  parentUserId: string,
  now: Date,
): Promise<GateVerdict> {
  const fresh =
    row.lane === 'payment' && now.getTime() - row.lastEventAt.getTime() <= BILLING_RECEIPT_FRESH_MS;
  const prefs = await loadLoopPrefsView(parentUserId, database);
  if (!categoryEnabled(prefs, 'alert')) return { kind: 'drop', reason: 'category_off' };

  const verdict = await assertProactiveSendAllowed(
    {
      familyId: row.familyId,
      parentUserId,
      kind: row.lane === 'payment' ? 'billing_receipt' : 'billing_change',
      now,
      urgent: fresh,
    },
    {
      ...buildOutboundGatePorts(database),
      watchConsentGranted: async () => true,
      parentClock: (id) => billingNoticeClock(database, id),
    },
  );
  if (!verdict.allowed) {
    switch (verdict.reason) {
      case 'sends_paused':
        return { kind: 'wait', until: new Date(now.getTime() + PAUSED_RETRY_MS) };
      case 'opt_out_unread':
        return { kind: 'wait', until: new Date(now.getTime() + OPT_OUT_RETRY_MS) };
      case 'quiet_hours':
        return { kind: 'wait', until: new Date(now.getTime() + QUIET_RETRY_MS) };
      case 'not_enrolled':
      case 'no_watch_consent':
        return { kind: 'drop', reason: 'no_consent' };
    }
  }

  // The same question the dispatch asks, so a text it would hold is never written.
  const [user] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId))
    .limit(1);
  if (!user) return { kind: 'drop', reason: 'no_consent' };
  if (!deliverableNow(prefs, now, user.timezone, fresh)) {
    return { kind: 'wait', until: new Date(now.getTime() + QUIET_RETRY_MS) };
  }
  return { kind: 'pass', fresh };
}

const lockFamily = (tx: Pick<Database, 'execute'>, familyId: string) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(${BILLING_NOTICE_LOCK_NS}::int, hashtext(${familyId}))`,
  );

/**
 * `open` to `sending`, under the family lock. A merge that landed since this tick read the
 * row may have added a subject the recipient was not resolved for, so the row waits for
 * the next tick instead of sending on stale facts.
 */
async function closeRow(
  database: Database,
  row: BillingNotice,
  parentUserId: string,
  resolvedFacts: BillingNoticeEventFacts,
  deps: BillingNoticeRunDeps,
): Promise<BillingNotice | null> {
  const now = deps.now();
  return database.transaction(async (tx) => {
    await lockFamily(tx, row.familyId);
    const [current] = await tx
      .select()
      .from(schema.billingNotices)
      .where(
        and(
          eq(schema.billingNotices.id, row.id),
          eq(schema.billingNotices.status, 'open'),
          lte(schema.billingNotices.nextTryAt, now),
        ),
      )
      .limit(1);
    if (!current || addsNoticeSubject(row.facts, current.facts)) return null;
    const [closed] = await tx
      .update(schema.billingNotices)
      .set({
        status: 'sending',
        parentUserId,
        facts: mergeNoticeFacts(current.facts, resolvedFacts),
        nextTryAt: new Date(now.getTime() + SEND_LEASE_MS),
        updatedAt: now,
      })
      .where(eq(schema.billingNotices.id, row.id))
      .returning();
    return closed ?? null;
  });
}

/** Still `open`, due again later. No attempt is used and no model is called. */
async function waitOpen(
  database: Database,
  row: BillingNotice,
  until: Date,
  now: Date,
): Promise<RowOutcome> {
  await database
    .update(schema.billingNotices)
    .set({ nextTryAt: until, updatedAt: now })
    .where(and(eq(schema.billingNotices.id, row.id), eq(schema.billingNotices.status, 'open')));
  return 'held';
}

/**
 * Back to `open`, so the row can absorb a later event. An event that arrived during the
 * attempt opened a row of its own: this one's facts merge into it and this one drops as
 * `merged`, so a refund and a cancel still end up as one text.
 */
async function returnToOpen(
  database: Database,
  row: BillingNotice,
  next: { nextTryAt: Date; attempts: number },
  deps: BillingNoticeRunDeps,
): Promise<void> {
  const now = deps.now();
  await database.transaction(async (tx) => {
    await lockFamily(tx, row.familyId);
    const [current] = await tx
      .select()
      .from(schema.billingNotices)
      .where(eq(schema.billingNotices.id, row.id))
      .limit(1);
    if (!current || (current.status !== 'sending' && current.status !== 'open')) return;
    const [other] = await tx
      .select()
      .from(schema.billingNotices)
      .where(
        and(
          eq(schema.billingNotices.familyId, row.familyId),
          eq(schema.billingNotices.lane, row.lane),
          eq(schema.billingNotices.status, 'open'),
          ne(schema.billingNotices.id, row.id),
        ),
      )
      .limit(1);
    if (!other) {
      await tx
        .update(schema.billingNotices)
        .set({ status: 'open', nextTryAt: next.nextTryAt, attempts: next.attempts, updatedAt: now })
        .where(eq(schema.billingNotices.id, row.id));
      return;
    }
    await tx
      .update(schema.billingNotices)
      .set({
        facts: mergeNoticeFacts(other.facts, current.facts),
        attempts: Math.max(other.attempts, next.attempts),
        nextTryAt: next.nextTryAt < other.nextTryAt ? next.nextTryAt : other.nextTryAt,
        lastEventAt:
          current.lastEventAt > other.lastEventAt ? current.lastEventAt : other.lastEventAt,
        parentUserId: addsNoticeSubject(other.facts, current.facts) ? null : other.parentUserId,
        updatedAt: now,
      })
      .where(eq(schema.billingNotices.id, other.id));
    await tx
      .update(schema.billingNotices)
      .set({ status: 'dropped', dropReason: 'merged', updatedAt: now })
      .where(eq(schema.billingNotices.id, row.id));
    await writeNoticeAudit.dropped(tx, current, { reason: 'merged', attempts: next.attempts });
  });
}

/**
 * One failed try. `attempts` is written only here, so nothing counts a try twice. The next
 * try is a fresh model write through every gate; the last one drops the row and pages.
 */
async function failAttempt(
  database: Database,
  row: BillingNotice,
  failure: NoticeFailure,
  deps: BillingNoticeRunDeps,
): Promise<RowOutcome> {
  const now = deps.now();
  const step = nextComposeHold(row.attempts, now);
  if (step.action === 'exhausted') {
    await finishDrop(database, row, 'send_retries_exhausted', row.attempts + 1, now);
    await pageUnsent(deps.pager, row, failure);
    return 'dropped';
  }
  await writeNoticeAudit.failed(database, row, { reason: failure, attempts: step.attempts });
  await returnToOpen(database, row, { nextTryAt: step.nextTryAt, attempts: step.attempts }, deps);
  return 'retrying';
}

async function dropNotice(
  database: Database,
  row: BillingNotice,
  reason: DropReason,
  deps: BillingNoticeRunDeps,
): Promise<RowOutcome> {
  const dropped = await finishDrop(database, row, reason, row.attempts, deps.now());
  if (dropped && isPagedDrop(reason)) await pageUnsent(deps.pager, row, reason);
  return 'dropped';
}

/** Amounts nobody will ever be told do not stay on the row. */
function withoutAmounts(facts: BillingNoticeEventFacts): BillingNoticeEventFacts {
  if (!facts.refunds) return facts;
  return {
    ...facts,
    refunds: facts.refunds.map(({ refundedMinor: _r, chargeMinor: _c, ...rest }) => rest),
  } as BillingNoticeEventFacts;
}

async function finishDrop(
  database: Database,
  row: BillingNotice,
  reason: DropReason,
  attempts: number,
  now: Date,
): Promise<boolean> {
  return database.transaction(async (tx) => {
    await lockFamily(tx, row.familyId);
    const [current] = await tx
      .select({ facts: schema.billingNotices.facts })
      .from(schema.billingNotices)
      .where(
        and(
          eq(schema.billingNotices.id, row.id),
          inArray(schema.billingNotices.status, ['open', 'sending']),
        ),
      )
      .limit(1);
    if (!current) return false;
    await tx
      .update(schema.billingNotices)
      .set({
        status: 'dropped',
        dropReason: reason,
        attempts,
        updatedAt: now,
        ...(reason === 'payer_unresolved' ? { facts: withoutAmounts(current.facts) } : {}),
      })
      .where(eq(schema.billingNotices.id, row.id));
    await writeNoticeAudit.dropped(tx, row, { reason, attempts });
    return true;
  });
}

async function pageUnsent(
  pager: OpsPager,
  row: BillingNotice,
  reason: Extract<OpsPage, { site: 'billing_notice_unsent' }>['facts']['reason'],
): Promise<void> {
  await pager.page({
    site: 'billing_notice_unsent',
    ref: row.id,
    facts: { lane: row.lane, reason },
  });
}
