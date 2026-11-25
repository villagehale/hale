import { type AuthorizedSignupPlanResume, type Database, schema } from '@hale/db';
import { and, eq, gt, inArray, isNotNull, isNull, lte, not, or, sql } from 'drizzle-orm';
import { isParentHeld } from '~/lib/channel/intake/opt-out-hold';
import { loadSmsChannelState } from '~/lib/channels/sms-consent-core';
import { redactSignupAudit } from '../audit';
import {
  type ShareableSignupField,
  ensureSignupConsent,
  fieldsPreparedToType,
  normalizeShareFields,
  signupProviderHost,
} from '../consent';
import { LINK_SPEND_CEILING_CENTS } from '../link/client';
import {
  ASKED_LAST_FIRST,
  type AskOrder,
  isOneSubmittingViolation,
  loadPendingOffer,
  loadSignupIdentity,
} from '../store';
import { releaseSignupHelpAttempt, signupHelpSlotReleaseEnabled } from '../signup-help-season';
import { hasUnstatedPrice } from '../terms/cart';
import { registrationPreflightEnabled } from '../terms/flag';
import { loadSignupTerms } from '../terms/store';
import type { SignupTermsApproved } from '../terms/types';
import type { SignupSession } from '../types';
import { registrationUrlAllowed } from '../url';

/** A parent ranks a few sessions, not a catalogue. */
export const MAX_PLAN_CHOICES = 5;

/** The terms row could not take this approval: the move to `planned` is undone with it. */
class TermsNotBound extends Error {}

export type ApprovePlanRefusal =
  | 'no_offer'
  | 'not_offer_parent'
  | 'choices'
  | 'max_price'
  | 'opens_at'
  | 'url_refused'
  | 'missing_detail'
  | 'consent_missing'
  | 'consent_wider'
  | 'consent_short'
  | 'not_stored';

/** Every slot any ranked choice would type: the consent has to cover all of them. */
export function planFieldsToType(
  identity: Parameters<typeof fieldsPreparedToType>[0],
  choices: readonly SignupSession[],
): ShareableSignupField[] {
  return [...new Set(choices.flatMap((choice) => fieldsPreparedToType(identity, choice)))];
}

/**
 * VIL-558 · the parent's day-before yes to a plan: this offer's child, these ranked
 * sessions, at most this price, from this open time. Writes the consent row from
 * the approving message first (hard rule #4: explicit consent per registration),
 * then moves the offer from `pending` to `planned` and writes one audit row.
 */
export async function approveSignupPlan(
  database: Database,
  input: {
    offerId: string;
    familyId: string;
    parentUserId: string;
    /** The inbound channel message that approved the plan. Never its body. */
    messageId: string;
    choiceIds: readonly string[];
    maxPriceCents: number;
    opensAt: Date;
    waiverAccepted: boolean;
    now: Date;
    /** Program is already open: a yes now is a register-now, not a day-before. */
    alreadyOpen?: boolean;
    /** VIL-715 · what this yes bound, written in the same transaction as the move. */
    terms?: { approved: SignupTermsApproved };
  },
): Promise<{ ok: true } | { ok: false; reason: ApprovePlanRefusal }> {
  // The named ask, not the newest: a family can hold several, and a yes may name an older one.
  const offer = await loadPendingOffer(database, input.familyId, input.offerId);
  if (!offer || offer.id !== input.offerId) return { ok: false, reason: 'no_offer' };
  // The run types this parent's details and pays with their city account's saved card, and
  // re-checks their standing before paying. Only their own yes can consent to that.
  if (offer.parentUserId !== input.parentUserId) return { ok: false, reason: 'not_offer_parent' };
  const ids = [...new Set(input.choiceIds)];
  const choices = ids.flatMap((id) => offer.sessions.filter((session) => session.id === id));
  if (
    ids.length !== input.choiceIds.length ||
    choices.length !== ids.length ||
    choices.length === 0 ||
    choices.length > MAX_PLAN_CHOICES
  ) {
    return { ok: false, reason: 'choices' };
  }
  // A class bound as free has a $0 maximum, and so does a pick with no stated price, which
  // holds at checkout. Nothing else may.
  const boundSessions = input.terms?.approved.sessions;
  const zeroAllowed =
    input.maxPriceCents === 0 &&
    boundSessions !== undefined &&
    (hasUnstatedPrice(boundSessions) ||
      boundSessions.every((session) => session.amount.kind === 'free'));
  if (
    !Number.isInteger(input.maxPriceCents) ||
    (input.maxPriceCents <= 0 && !zeroAllowed) ||
    input.maxPriceCents > LINK_SPEND_CEILING_CENTS
  ) {
    return { ok: false, reason: 'max_price' };
  }
  if (!input.alreadyOpen && input.opensAt.getTime() <= input.now.getTime()) {
    return { ok: false, reason: 'opens_at' };
  }
  const allowed = registrationUrlAllowed(offer.registrationUrl);
  if (!allowed.ok) return { ok: false, reason: 'url_refused' };
  const identity = await loadSignupIdentity(database, {
    familyId: input.familyId,
    childId: offer.childId,
    parentUserId: input.parentUserId,
    now: input.now,
  });
  if (!identity) return { ok: false, reason: 'missing_detail' };
  const consent = await ensureSignupConsent(database, {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    messageId: input.messageId,
    activityKey: offer.activityKey,
    providerHost: signupProviderHost(new URL(allowed.href).hostname),
    fieldsAllowed: planFieldsToType(identity, choices),
    now: input.now,
  });
  if (!consent.ok) return { ok: false, reason: consent.reason };
  const moveToPlanned = (tx: Database) =>
    tx
      .update(schema.authorizedSignupOffers)
      .set({
        status: 'planned',
        planChoiceIds: ids,
        planMaxPriceCents: input.maxPriceCents,
        planOpensAt: input.opensAt,
        planWaiverAccepted: input.waiverAccepted,
        planApprovedAt: input.now,
        authorizingMessageId: input.messageId,
        planAlreadyOpen: input.alreadyOpen === true,
        updatedAt: input.now,
      })
      .where(
        and(
          eq(schema.authorizedSignupOffers.id, offer.id),
          eq(schema.authorizedSignupOffers.familyId, input.familyId),
          eq(schema.authorizedSignupOffers.status, 'pending'),
        ),
      )
      .returning({ id: schema.authorizedSignupOffers.id });
  const bound = input.terms;
  const moved = bound
    ? await database
        .transaction(async (rawTx) => {
          const tx = rawTx as unknown as Database;
          const rows = await moveToPlanned(tx);
          if (rows.length === 0) return rows;
          const terms = schema.authorizedSignupTerms;
          const written = await tx
            .update(terms)
            .set({
              approved: bound.approved,
              approvingMessageId: input.messageId,
              approvedAt: input.now,
            })
            .where(
              and(
                eq(terms.offerId, offer.id),
                eq(terms.familyId, input.familyId),
                isNull(terms.approvedAt),
                isNotNull(terms.askedMessageId),
              ),
            )
            .returning({ id: terms.id });
          // Rolls the move back: a plan may not exist without the approval it runs on.
          if (written.length === 0) throw new TermsNotBound();
          return rows;
        })
        .catch((err: unknown) => {
          if (err instanceof TermsNotBound) return [];
          throw err;
        })
    : await moveToPlanned(database);
  if (moved.length === 0) return { ok: false, reason: 'not_stored' };
  await writePlanAudit(database, {
    familyId: input.familyId,
    actor: input.parentUserId,
    offerId: offer.id,
    after: {
      step: 'plan_approved',
      choices: ids.length,
      maxPriceCents: input.maxPriceCents,
      opensAt: input.opensAt.toISOString(),
      waiverAccepted: input.waiverAccepted,
      host: new URL(allowed.href).hostname,
      ...(bound ? { bound: true, hold: bound.approved.hold } : {}),
    },
  });
  return { ok: true };
}

/**
 * Put a running plan back to `planned` with what the site showed, so Hale waits
 * on the parent instead of handing the offer back. Used for a rejected password
 * and for options that do not match what they asked for.
 */
export async function parkSignupPlan(
  database: Database,
  input: {
    offerId: string;
    familyId: string;
    availability: Record<string, unknown>;
    now: Date;
  },
): Promise<boolean> {
  const offers = schema.authorizedSignupOffers;
  const rows = await database
    .update(offers)
    .set({
      status: 'planned',
      planResume: null,
      planLeaseUntil: null,
      planAvailability: input.availability,
      planAvailabilityAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(offers.id, input.offerId),
        eq(offers.familyId, input.familyId),
        inArray(offers.status, ['planned', 'submitting']),
      ),
    )
    .returning({ id: offers.id });
  return rows.length > 0;
}

export interface ClaimedPlan {
  offerId: string;
  familyId: string;
  childId: string;
  parentUserId: string;
  activityKey: string;
  registrationUrl: string;
  sessions: SignupSession[];
  choiceIds: string[];
  maxPriceCents: number;
  opensAt: Date;
  waiverAccepted: boolean;
  messageId: string;
  /** Null on a plan's first sweep; where its run stood when a later sweep picks it up. */
  resume: AuthorizedSignupPlanResume | null;
  /** The parent took the plan back while its run was going. */
  takenBack: boolean;
  alreadyOpen: boolean;
  availability: Record<string, unknown> | null;
}

type OfferRow = typeof schema.authorizedSignupOffers.$inferSelect;

function claimedPlan(row: OfferRow, resume: AuthorizedSignupPlanResume | null): ClaimedPlan {
  if (
    !row.planChoiceIds ||
    row.planMaxPriceCents === null ||
    !row.planOpensAt ||
    !row.authorizingMessageId
  ) {
    throw new Error('a planned offer is missing its plan');
  }
  return {
    offerId: row.id,
    familyId: row.familyId,
    childId: row.childId,
    parentUserId: row.parentUserId,
    activityKey: row.activityKey,
    registrationUrl: row.registrationUrl,
    sessions: row.sessions,
    choiceIds: row.planChoiceIds,
    maxPriceCents: row.planMaxPriceCents,
    opensAt: row.planOpensAt,
    waiverAccepted: row.planWaiverAccepted === true,
    messageId: row.authorizingMessageId,
    resume,
    takenBack: row.planCancelRequestedAt !== null,
    alreadyOpen: row.planAlreadyOpen === true,
    availability: row.planAvailability,
  };
}

/**
 * Claims the earliest planned offer whose open is within `leadMs`, moving it from
 * `planned` to `submitting`. A family that already has a registration running is
 * skipped, so one family never holds two sessions at once; the 0206 unique index holds
 * that when two sweeps overlap, and the loser gets `contended`. The claim stores a first
 * resume token and holds the plan for `leaseMs`, so a sweep the platform kills before
 * its run exists still leaves a plan the next sweep can pick up.
 */
export async function claimDuePlan(
  database: Database,
  input: { now: Date; leadMs: number; leaseMs: number },
): Promise<ClaimedPlan | 'contended' | null> {
  const offers = schema.authorizedSignupOffers;
  const dueBy = new Date(input.now.getTime() + input.leadMs).toISOString();
  const claim = database
    .update(offers)
    .set({
      status: 'submitting',
      planResume: { phase: 'signup', runId: null, sessionId: null, browserId: null },
      planLeaseUntil: new Date(input.now.getTime() + input.leaseMs),
      updatedAt: input.now,
    })
    .where(
      sql`${offers.id} = (
        select o.id from authorized_signup_offers o
        where o.status = 'planned'
          and o.plan_opens_at <= ${dueBy}::timestamptz
          and (
            o.plan_availability is null
            or o.plan_availability->>'kind' in ('join_waitlist', 'take_option')
          )
          and not exists (
            select 1 from authorized_signup_offers busy
            where busy.family_id = o.family_id and busy.status = 'submitting'
          )
        order by o.plan_opens_at
        limit 1
        for update skip locked
      ) and ${offers.status} = 'planned'`,
    )
    .returning();
  let row: Awaited<typeof claim>[number] | undefined;
  try {
    [row] = await claim;
  } catch (err) {
    // An overlapping sweep claimed this family first; its claim is committed now.
    if (isOneSubmittingViolation(err)) return 'contended';
    throw err;
  }
  return row ? claimedPlan(row, null) : null;
}

/** The audit step of an ops stop, written once per plan in the transaction that marks it. */
const PLAN_OPS_STOP_STEP = 'plan_ops_stop';
/**
 * An ops stop is on this plan. A parent's take-back sets the same column, so this row is what
 * tells them apart. Audit rows are immutable, so an ops stop is never undone.
 */
const hasOpsStop = sql`exists (
  select 1 from ${schema.auditLog} ops
  where ops.family_id = ${schema.authorizedSignupOffers.familyId}
    and ops.target_id = ${schema.authorizedSignupOffers.id}::text
    and ops.action_taken = 'authorized_signup_step'
    and ops.after->>'step' = ${PLAN_OPS_STOP_STEP}
)`;

/**
 * Puts an unstarted plan back to `planned` while registration is still ahead.
 * A provider run, or a payment that may exist, stays where it is.
 *
 * Without `offerId` this recovers abandoned claims only: a live lease belongs to
 * a sweep that may already be driving the plan, and a clock captured before
 * prep must not clear it. With `offerId` the sweep is letting go of the claim
 * it holds. A plan with an ops stop stays out of `planned`, where the parent could still set
 * it: the sweep lets it go instead.
 */
export async function releaseUnstartedPlansBeforeOpen(
  database: Database,
  input: { now: Date; offerId?: string },
): Promise<Array<{ id: string; familyId: string; parentUserId: string; opensAt: Date | null }>> {
  const offers = schema.authorizedSignupOffers;
  const abandoned = or(isNull(offers.planLeaseUntil), lte(offers.planLeaseUntil, input.now));
  return database
    .update(offers)
    .set({
      status: 'planned',
      planResume: null,
      planLeaseUntil: null,
      updatedAt: input.now,
    })
    .where(
      and(
        input.offerId ? eq(offers.id, input.offerId) : abandoned,
        eq(offers.status, 'submitting'),
        gt(offers.planOpensAt, input.now),
        or(isNull(offers.planAlreadyOpen), eq(offers.planAlreadyOpen, false)),
        not(hasOpsStop),
        sql`(
          ${offers.planResume} is null
          or (
            coalesce(${offers.planResume}->>'phase', 'signup') <> 'paying'
            and (${offers.planResume}->>'runId') is null
          )
        )`,
      ),
    )
    .returning({
      id: offers.id,
      familyId: offers.familyId,
      parentUserId: offers.parentUserId,
      opensAt: offers.planOpensAt,
    });
}

/**
 * Claims the earliest plan whose run outlived an earlier sweep: still `submitting`, with a
 * resume token, and no sweep holding it (it checkpointed, or its lease ran out because the
 * platform killed it). Holds it for `leaseMs`.
 */
export async function claimResumablePlan(
  database: Database,
  input: { now: Date; leaseMs: number },
): Promise<ClaimedPlan | null> {
  const offers = schema.authorizedSignupOffers;
  const now = input.now.toISOString();
  const [row] = await database
    .update(offers)
    .set({ planLeaseUntil: new Date(input.now.getTime() + input.leaseMs), updatedAt: input.now })
    .where(
      sql`${offers.id} = (
        select o.id from authorized_signup_offers o
        where o.status = 'submitting'
          and o.plan_resume is not null
          and (o.plan_lease_until is null or o.plan_lease_until <= ${now}::timestamptz)
        order by o.plan_opens_at
        limit 1
        for update skip locked
      ) and ${offers.status} = 'submitting'
        and (${offers.planLeaseUntil} is null or ${offers.planLeaseUntil} <= ${now}::timestamptz)`,
    )
    .returning();
  if (!row?.planResume) return null;
  return claimedPlan(row, row.planResume);
}

/**
 * Stores where a running plan stands. `letGo` also ends this sweep's hold, so the next
 * sweep picks the plan up at once. The first `paying` checkpoint, written before any payment
 * run exists, is stored only while the plan has not been taken back, in the same statement
 * {@link cancelSignupPlan} locks: either the take-back lands first and nothing is paid, or
 * the payment does and the take-back is told so. False when it was refused.
 */
export async function savePlanResume(
  database: Database,
  input: { offerId: string; familyId: string; resume: AuthorizedSignupPlanResume; letGo: boolean },
): Promise<boolean> {
  const offers = schema.authorizedSignupOffers;
  const startsPayment = input.resume.phase === 'paying' && input.resume.runId === null;
  const rows = await database
    .update(offers)
    .set({
      planResume: input.resume,
      ...(input.letGo ? { planLeaseUntil: null } : {}),
    })
    .where(
      and(
        eq(offers.id, input.offerId),
        eq(offers.familyId, input.familyId),
        eq(offers.status, 'submitting'),
        startsPayment ? isNull(offers.planCancelRequestedAt) : undefined,
      ),
    )
    .returning({ id: offers.id });
  return rows.length > 0;
}

/** Read just before payment: the parent took the plan back while its run was going. */
export async function planTakenBack(
  database: Database,
  input: { offerId: string; familyId: string },
): Promise<boolean> {
  const offers = schema.authorizedSignupOffers;
  const [row] = await database
    .select({ at: offers.planCancelRequestedAt })
    .from(offers)
    .where(and(eq(offers.id, input.offerId), eq(offers.familyId, input.familyId)))
    .limit(1);
  return row?.at != null;
}

async function isFamilyMember(
  database: Database,
  familyId: string,
  userId: string,
): Promise<boolean> {
  const [member] = await database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(
      and(eq(schema.familyMembers.familyId, familyId), eq(schema.familyMembers.userId, userId)),
    )
    .limit(1);
  return member !== undefined;
}

/** Why a parent's yes to a plan no longer stands. Never written to a family-visible row. */
export type PlanLapse = 'not_member' | 'erasure_scheduled' | 'channel_not_enrolled' | 'sender_held';

/**
 * Rule #4 at the moment it matters: the yes was given a day before, so before a plan
 * starts and again just before it pays, the parent must still be a member of the
 * family, the family must not be scheduled for erasure, the parent's live channel must
 * still be enrolled (an opt-out revokes it), and no unread text of theirs may be held as
 * a possible stop. Null when the yes still stands.
 */
export async function planLapse(
  database: Database,
  input: { familyId: string; parentUserId: string },
): Promise<PlanLapse | null> {
  if (!(await isFamilyMember(database, input.familyId, input.parentUserId))) return 'not_member';
  const [family] = await database
    .select({ scheduledDeletionAt: schema.families.scheduledDeletionAt })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId))
    .limit(1);
  if (!family || family.scheduledDeletionAt !== null) return 'erasure_scheduled';
  if (!(await loadSmsChannelState(database, input.parentUserId)).enrolled) {
    return 'channel_not_enrolled';
  }
  if (await isParentHeld(database, input.parentUserId)) return 'sender_held';
  return null;
}

/**
 * A plan parked on its takeover card holds the lease to the card's end with no sweep driving
 * it: a stop or a lapsed yes frees it so the next sweep lets the browser go. A lease a sweep
 * took since then stays its own.
 */
const leaseFreedFromParkedCard = sql`case
  when ${schema.authorizedSignupOffers.planResume}->>'phase' = 'takeover'
    and ${schema.authorizedSignupOffers.planResume}->>'doneAt' is null
    and ${schema.authorizedSignupOffers.planLeaseUntil} = (${schema.authorizedSignupOffers.planResume}->>'expiresAt')::timestamptz
  then null else ${schema.authorizedSignupOffers.planLeaseUntil} end`;

/**
 * Frees each plan parked on its takeover card whose parent's yes no longer stands, so this
 * sweep's claim ends it and lets the browser go instead of leaving it open until the card runs
 * out. A read that throws frees nothing for that plan and never stops the sweep; the next one
 * reads it again. Returns how many were freed.
 */
export async function freeLapsedParkedPlans(database: Database): Promise<number> {
  const offers = schema.authorizedSignupOffers;
  const parkedOnCard = and(
    eq(offers.status, 'submitting'),
    sql`${offers.planResume}->>'phase' = 'takeover'`,
    sql`${offers.planResume}->>'doneAt' is null`,
    sql`${offers.planResume}->>'lapsedAt' is null`,
    sql`${offers.planLeaseUntil} = (${offers.planResume}->>'expiresAt')::timestamptz`,
  );
  const parked = await database
    .select({ id: offers.id, familyId: offers.familyId, parentUserId: offers.parentUserId })
    .from(offers)
    .where(parkedOnCard);
  let freed = 0;
  for (const plan of parked) {
    const lapse = await planLapse(database, plan).catch((err: unknown) => {
      console.warn(
        { offerId: plan.id, error: err instanceof Error ? err.name : 'unknown' },
        'signup plans: could not read a parked plan’s yes',
      );
      return null;
    });
    if (!lapse) continue;
    const rows = await database
      .update(offers)
      .set({ planLeaseUntil: leaseFreedFromParkedCard })
      .where(and(eq(offers.id, plan.id), eq(offers.familyId, plan.familyId), parkedOnCard))
      .returning({ id: offers.id });
    freed += rows.length;
  }
  return freed;
}

/**
 * A parent of the family takes back a plan, with one audit row either way.
 *
 * - `cancelled`: before the open, `planned` to `handed_back`, with the take-back time stamped
 *   so the claim reader has the row that backs "I cancelled it".
 * - `cancel_requested`: its run is going (a queue, perhaps checkpointed between sweeps). The
 *   take-back is marked on the offer; the next sweep lets the run go instead of resuming it,
 *   and no payment starts after it ({@link savePlanResume}).
 * - `paying`: the payment had already started. It is marked all the same, but the sweep reads
 *   what the payment did and tells the parent.
 */
export async function cancelSignupPlan(
  database: Database,
  input: { offerId: string; familyId: string; actor: string; now: Date },
): Promise<'cancelled' | 'cancel_requested' | 'paying' | 'not_planned'> {
  if (!(await isFamilyMember(database, input.familyId, input.actor))) return 'not_planned';
  const offers = schema.authorizedSignupOffers;
  const ours = and(eq(offers.id, input.offerId), eq(offers.familyId, input.familyId));
  const rows = await database
    .update(offers)
    .set({ status: 'handed_back', planCancelRequestedAt: input.now, updatedAt: input.now })
    .where(and(ours, eq(offers.status, 'planned')))
    .returning({ id: offers.id, availability: offers.planAvailability });
  if (rows.length > 0) {
    await writePlanAudit(database, {
      familyId: input.familyId,
      actor: input.actor,
      offerId: input.offerId,
      after: { step: 'plan_cancelled' },
    });
    // A parked plan's run reached the provider, so its sign-up stays spent.
    if (rows[0]?.availability === null) await giveBackSeasonSlot(database, input);
    return 'cancelled';
  }
  const [running] = await database
    .update(offers)
    .set({
      planCancelRequestedAt: sql`coalesce(${offers.planCancelRequestedAt}, ${input.now.toISOString()}::timestamptz)`,
      planLeaseUntil: leaseFreedFromParkedCard,
      updatedAt: input.now,
    })
    .where(and(ours, eq(offers.status, 'submitting'), isNotNull(offers.planResume)))
    .returning({ resume: offers.planResume });
  if (!running?.resume) return 'not_planned';
  const phase = running.resume.phase;
  await writePlanAudit(database, {
    familyId: input.familyId,
    actor: input.actor,
    offerId: input.offerId,
    after: { step: 'plan_cancel_requested', phase },
  });
  return phase === 'paying' ? 'paying' : 'cancel_requested';
}

/** The season sign-up a yes took, back to the family: no run of this plan reached a provider. */
async function giveBackSeasonSlot(
  database: Database,
  input: { offerId: string; familyId: string; now: Date },
): Promise<void> {
  if (!signupHelpSlotReleaseEnabled()) return;
  const read = await loadSignupTerms(database, {
    offerId: input.offerId,
    familyId: input.familyId,
  });
  const seasonKey = read.status === 'read' ? read.row.approved?.seasonKey : null;
  if (!seasonKey) return;
  await releaseSignupHelpAttempt(database, {
    familyId: input.familyId,
    seasonKey,
    now: input.now,
  });
}

/** Plans by run phase: all an ops stop reports, so it cannot print a family, offer or host. */
export interface PlanPhaseCounts {
  signup: number;
  paying: number;
}

/** A one-shot signup is `submitting` too, but only a plan has a resume token. */
const isRunningPlan = and(
  eq(schema.authorizedSignupOffers.status, 'submitting'),
  isNotNull(schema.authorizedSignupOffers.planResume),
);
const resumePhase = sql<
  AuthorizedSignupPlanResume['phase']
>`${schema.authorizedSignupOffers.planResume}->>'phase'`;

function countByPhase(
  rows: ReadonlyArray<{ phase: AuthorizedSignupPlanResume['phase'] }>,
): PlanPhaseCounts {
  const paying = rows.filter((row) => row.phase === 'paying').length;
  return { signup: rows.length - paying, paying };
}

/**
 * {@link cancelSignupPlan}'s mark on every running plan at once: an incident stop that needs
 * no redeploy. A plan not yet past its paying checkpoint can no longer start a payment
 * ({@link savePlanResume}), and a later sweep lets each run go without a text, unless a charge
 * may exist: a plan in `paying` is marked too, its payment may still run, and the sweep reads
 * what it did and tells the parent. A plan the parent already took back keeps their time.
 * Each mark and its one audit row land together. Returns the plans marked by this call.
 */
export async function requestStopForRunningPlans(
  database: Database,
  input: { now: Date },
): Promise<PlanPhaseCounts> {
  const offers = schema.authorizedSignupOffers;
  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    // Two stops at once would each read "no stop yet" and write a second audit row.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${PLAN_OPS_STOP_STEP}))`);
    const stopped = await tx
      .update(offers)
      .set({
        planCancelRequestedAt: sql`coalesce(${offers.planCancelRequestedAt}, ${input.now.toISOString()}::timestamptz)`,
        planLeaseUntil: leaseFreedFromParkedCard,
        updatedAt: input.now,
      })
      .where(and(isRunningPlan, not(hasOpsStop)))
      .returning({ id: offers.id, familyId: offers.familyId, phase: resumePhase });
    for (const row of stopped) {
      await writePlanAudit(tx, {
        familyId: row.familyId,
        actor: 'system',
        offerId: row.id,
        after: { step: PLAN_OPS_STOP_STEP, phase: row.phase },
      });
    }
    return countByPhase(stopped);
  });
}

/** Every running plan by phase, and those with no ops stop on them yet. Reads only. */
export async function countRunningPlans(
  database: Database,
): Promise<{ running: PlanPhaseCounts; notStopped: PlanPhaseCounts }> {
  const offers = schema.authorizedSignupOffers;
  const running = await database.select({ phase: resumePhase }).from(offers).where(isRunningPlan);
  const notStopped = await database
    .select({ phase: resumePhase })
    .from(offers)
    .where(and(isRunningPlan, not(hasOpsStop)));
  return { running: countByPhase(running), notStopped: countByPhase(notStopped) };
}

export type PlanStopReport =
  | { mode: 'dry_run'; wouldStop: PlanPhaseCounts; stillRunning: PlanPhaseCounts }
  | { mode: 'apply'; stopped: PlanPhaseCounts; stillRunning: PlanPhaseCounts };

/** The ops command. Its report is counts by phase, so it cannot name a family. */
export async function runPlanStop(
  database: Database,
  input: { apply: boolean; now: Date },
): Promise<PlanStopReport> {
  if (!input.apply) {
    const { running, notStopped } = await countRunningPlans(database);
    return { mode: 'dry_run', wouldStop: notStopped, stillRunning: running };
  }
  const stopped = await requestStopForRunningPlans(database, { now: input.now });
  const { running } = await countRunningPlans(database);
  return { mode: 'apply', stopped, stillRunning: running };
}

/**
 * An ops stop is on this plan, as opposed to only its parent's own take-back. Not gated on
 * the flag: only `--apply` writes a stop, so a row means someone ran it.
 */
export async function planOpsStopped(
  database: Database,
  input: { offerId: string; familyId: string },
): Promise<boolean> {
  const offers = schema.authorizedSignupOffers;
  const [row] = await database
    .select({ id: offers.id })
    .from(offers)
    .where(and(eq(offers.id, input.offerId), eq(offers.familyId, input.familyId), hasOpsStop))
    .limit(1);
  return row !== undefined;
}

/**
 * {@link parkSignupPlan} for a run's own ending, unless an ops stop is on the plan. The row
 * lock orders the two: a stop either committed before this read or waits and finds the plan
 * no longer running, so a stopped plan is never parked for the parent to answer.
 */
export async function parkUnlessOpsStopped(
  database: Database,
  input: Parameters<typeof parkSignupPlan>[1],
): Promise<'parked' | 'ops_stopped'> {
  const offers = schema.authorizedSignupOffers;
  return database.transaction(async (rawTx) => {
    const tx = rawTx as unknown as Database;
    await tx
      .select({ id: offers.id })
      .from(offers)
      .where(and(eq(offers.id, input.offerId), eq(offers.familyId, input.familyId)))
      .for('update');
    if (await planOpsStopped(tx, input)) return 'ops_stopped';
    await parkSignupPlan(tx, input);
    return 'parked';
  });
}

/**
 * A family's offer the day-before conversation can still act on: before its open, or
 * `running` while its run is going and the parent has not taken it back yet.
 */
export interface ConversablePlan extends AskOrder {
  offerId: string;
  childId: string;
  activityKey: string;
  /** The parent Hale asked: only their words may set the plan or take it back. */
  parentUserId: string;
  status: 'pending' | 'planned' | 'running';
  /** The program's public name, or null for an offer recorded before names were kept. */
  activityLabel: string | null;
  providerHost: string;
  registrationUrl: string;
  sessions: SignupSession[];
  approvedPriceCents: number | null;
  opensAt: Date;
  plan: { choiceIds: string[]; maxPriceCents: number; waiverAccepted: boolean } | null;
  alreadyOpen: boolean;
  availability: Record<string, unknown> | null;
}

/**
 * The offers with a known open still ahead: a `pending` offer the coach recorded with its
 * open time, or a `planned` one the parent may still take back. A plan whose run is going
 * (possibly checkpointed between sweeps) can still be taken back too. In `AskOrder`, the
 * one whose text reached the parent last first; which of the family's asks a message answers
 * is `loadLiveAsks`'s ordering, plans and one-shot asks together.
 */
export async function loadConversablePlans(
  database: Database,
  input: { familyId: string; now: Date },
): Promise<ConversablePlan[]> {
  const offers = schema.authorizedSignupOffers;
  const rows = await database
    .select()
    .from(offers)
    .where(
      and(
        eq(offers.familyId, input.familyId),
        or(
          and(
            inArray(offers.status, ['pending', 'planned']),
            or(
              gt(offers.planOpensAt, input.now),
              eq(offers.planAlreadyOpen, true),
              sql`${offers.planAvailability} ->> 'kind' in ('options_mismatch', 'password_rejected')`,
              // VIL-715: an ask with terms stays a plan past its open, never a one-shot.
              registrationPreflightEnabled(input.familyId)
                ? sql`${offers.status} = 'pending' and exists (select 1 from ${schema.authorizedSignupTerms} where ${schema.authorizedSignupTerms.offerId} = ${offers.id})`
                : undefined,
            ),
          ),
          and(
            eq(offers.status, 'submitting'),
            isNotNull(offers.planResume),
            isNull(offers.planCancelRequestedAt),
          ),
        ),
      ),
    )
    .orderBy(...ASKED_LAST_FIRST);
  return rows.flatMap((row) => {
    if (!row.planOpensAt) return [];
    const status =
      row.status === 'submitting'
        ? 'running'
        : row.status === 'pending' || row.status === 'planned'
          ? row.status
          : null;
    if (!status) return [];
    const planned =
      status !== 'pending' && row.planChoiceIds && row.planMaxPriceCents !== null
        ? {
            choiceIds: row.planChoiceIds,
            maxPriceCents: row.planMaxPriceCents,
            waiverAccepted: row.planWaiverAccepted === true,
          }
        : null;
    return [
      {
        offerId: row.id,
        childId: row.childId,
        activityKey: row.activityKey,
        parentUserId: row.parentUserId,
        lastAskedSeq: row.lastAskedSeq,
        createdAt: row.createdAt,
        status,
        activityLabel: row.activityLabel,
        providerHost: row.providerHost,
        registrationUrl: row.registrationUrl,
        sessions: row.sessions,
        approvedPriceCents: row.approvedPriceCents,
        opensAt: row.planOpensAt,
        plan: planned,
        alreadyOpen: row.planAlreadyOpen === true,
        availability: row.planAvailability,
      },
    ];
  });
}

/**
 * The consent row the plan's own parent wrote from the approving message. Read-only: a run
 * never writes consent.
 */
export async function loadPlanConsent(
  database: Database,
  input: {
    familyId: string;
    parentUserId: string;
    messageId: string;
    activityKey: string;
    providerHost: string;
  },
): Promise<ShareableSignupField[] | null> {
  const consents = schema.authorizedSignupConsents;
  const [row] = await database
    .select({ fieldsAllowed: consents.fieldsAllowed })
    .from(consents)
    .where(
      and(
        eq(consents.familyId, input.familyId),
        eq(consents.parentUserId, input.parentUserId),
        eq(consents.messageId, input.messageId),
        eq(consents.activityKey, input.activityKey),
        eq(consents.providerHost, signupProviderHost(input.providerHost)),
      ),
    )
    .limit(1);
  return row ? normalizeShareFields(row.fieldsAllowed) : null;
}

/** One immutable audit row (rule #6). Ids, codes, counts and a host; never a person. */
export async function writePlanAudit(
  database: Pick<Database, 'insert'>,
  input: { familyId: string; actor: string; offerId: string; after: Record<string, unknown> },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.actor,
    actionTaken: 'authorized_signup_step',
    targetTable: 'authorized_signup_offers',
    targetId: input.offerId,
    after: redactSignupAudit(input.after),
  });
}
