import { type Database, schema } from '@hale/db';
import { and, eq, sql } from 'drizzle-orm';
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
import { isOneSubmittingViolation, loadPendingOffer, loadSignupIdentity } from '../store';
import type { SignupSession } from '../types';
import { registrationUrlAllowed } from '../url';

/** A parent ranks a few sessions, not a catalogue. */
export const MAX_PLAN_CHOICES = 5;

export type ApprovePlanRefusal =
  | 'no_offer'
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
  },
): Promise<{ ok: true } | { ok: false; reason: ApprovePlanRefusal }> {
  const offer = await loadPendingOffer(database, input.familyId);
  if (!offer || offer.id !== input.offerId) return { ok: false, reason: 'no_offer' };
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
  if (
    !Number.isInteger(input.maxPriceCents) ||
    input.maxPriceCents <= 0 ||
    input.maxPriceCents > LINK_SPEND_CEILING_CENTS
  ) {
    return { ok: false, reason: 'max_price' };
  }
  if (input.opensAt.getTime() <= input.now.getTime()) return { ok: false, reason: 'opens_at' };
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
  const rows = await database
    .update(schema.authorizedSignupOffers)
    .set({
      status: 'planned',
      planChoiceIds: ids,
      planMaxPriceCents: input.maxPriceCents,
      planOpensAt: input.opensAt,
      planWaiverAccepted: input.waiverAccepted,
      planApprovedAt: input.now,
      authorizingMessageId: input.messageId,
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
  if (rows.length === 0) return { ok: false, reason: 'not_stored' };
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
    },
  });
  return { ok: true };
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
}

/**
 * Claims the earliest planned offer whose open is within `leadMs`, moving it from
 * `planned` to `submitting`. A family that already has a registration running is
 * skipped, so one family never holds two sessions at once; the 0206 unique index holds
 * that when two sweeps overlap, and the loser gets `contended`.
 */
export async function claimDuePlan(
  database: Database,
  input: { now: Date; leadMs: number },
): Promise<ClaimedPlan | 'contended' | null> {
  const offers = schema.authorizedSignupOffers;
  const dueBy = new Date(input.now.getTime() + input.leadMs).toISOString();
  const claim = database
    .update(offers)
    .set({ status: 'submitting', updatedAt: input.now })
    .where(
      sql`${offers.id} = (
        select o.id from authorized_signup_offers o
        where o.status = 'planned'
          and o.plan_opens_at <= ${dueBy}::timestamptz
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
  if (!row) return null;
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
  };
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
 * A parent of the family takes back a plan before the open: `planned` to `handed_back`,
 * with one audit row. A plan already running is not stopped here; the check before
 * payment ({@link planLapse}) is what stops a running one.
 */
export async function cancelSignupPlan(
  database: Database,
  input: { offerId: string; familyId: string; actor: string; now: Date },
): Promise<'cancelled' | 'not_planned'> {
  if (!(await isFamilyMember(database, input.familyId, input.actor))) return 'not_planned';
  const rows = await database
    .update(schema.authorizedSignupOffers)
    .set({ status: 'handed_back', updatedAt: input.now })
    .where(
      and(
        eq(schema.authorizedSignupOffers.id, input.offerId),
        eq(schema.authorizedSignupOffers.familyId, input.familyId),
        eq(schema.authorizedSignupOffers.status, 'planned'),
      ),
    )
    .returning({ id: schema.authorizedSignupOffers.id });
  if (rows.length === 0) return 'not_planned';
  await writePlanAudit(database, {
    familyId: input.familyId,
    actor: input.actor,
    offerId: input.offerId,
    after: { step: 'plan_cancelled' },
  });
  return 'cancelled';
}

/** The consent row the approving message wrote. Read-only: a run never writes consent. */
export async function loadPlanConsent(
  database: Database,
  input: { familyId: string; messageId: string; activityKey: string; providerHost: string },
): Promise<ShareableSignupField[] | null> {
  const consents = schema.authorizedSignupConsents;
  const [row] = await database
    .select({ fieldsAllowed: consents.fieldsAllowed })
    .from(consents)
    .where(
      and(
        eq(consents.familyId, input.familyId),
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
  database: Database,
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
