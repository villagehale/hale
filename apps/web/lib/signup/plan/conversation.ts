import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { readParentLanguage } from '~/lib/channel/parent-language';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { signupProviderHost } from '../consent';
import type { SignupRunInput, SignupRunResult } from '../run';
import { siteChoiceSchema } from '../site-choices';
import { loadSignupIdentity, markOffer } from '../store';
import type { SignupSession } from '../types';
import { registrationPlanRunEnabled } from './flag';
import { type MismatchReader, createMismatchReader } from './mismatch-reader';
import { hasPlanNotice, recordPlanNotice } from './prep';
import { type PlanReader, type PlanReading, createPlanReader } from './reader';
import {
  type ConversablePlan,
  approveSignupPlan,
  cancelSignupPlan,
  loadConversablePlan,
  parkSignupPlan,
  writePlanAudit,
} from './store';
import { planReplyMode } from './towns';
import {
  type PlanReplyFacts,
  type PlanReplyMoment,
  type PlanReplySession,
  type PlanReplyWriter,
  createPlanReplyWriter,
  planOpensAtLocal,
  planReplyBody,
} from './writer';

export interface PlanTurnDeps {
  /** Reads the parent's yes or take-back. Undefined uses the reply model. */
  planReader?: PlanReader;
  /** Writes the reply. Undefined uses the reply model. */
  planWriter?: PlanReplyWriter;
  /** Reads a pick after the site's options did not match. Undefined uses the reply model. */
  mismatchReader?: MismatchReader;
  /** Sends the provider email from the parent's Gmail after they say yes. */
  sendProviderEmail?: (input: {
    familyId: string;
    actorUserId: string;
    to: string;
    subject: string;
    body: string;
  }) => Promise<void>;
  /** True when this sender holds a group seat that may not authorize a sign-up. */
  declineSeat?: () => Promise<boolean>;
}

/**
 * VIL-558 · the day-before plan conversation. Owns the turn when the family has an offer
 * whose open is still ahead and the plan lane is on; null otherwise, and the ordinary
 * sign-up reply runs. A model reads the parent's words ({@link PlanReader}); a yes calls
 * `approveSignupPlan`, a take-back calls `cancelSignupPlan` (or closes the offer when it
 * was never approved). Every claimed turn writes one audit row and a model-written reply.
 */
export async function runPlanTurn(
  database: Database,
  input: SignupRunInput,
  deps: PlanTurnDeps = {},
): Promise<SignupRunResult | null> {
  if (!registrationPlanRunEnabled()) return null;
  const plan = await loadConversablePlan(database, { familyId: input.familyId, now: input.now });
  if (!plan) return null;
  if (plan.availability && plan.availability.kind === 'options_mismatch') {
    return runMismatchTurn(database, input, deps, plan);
  }
  const reader = deps.planReader ?? createPlanReader(() => resolveReplyClient(undefined));
  const reading: PlanReading | null = await reader.read({
    text: input.body,
    offer: {
      // A running plan is the approved plan to its reader: it can only be taken back.
      status: plan.status === 'running' ? 'planned' : plan.status,
      opensAt: plan.opensAt,
      sessions: plan.sessions,
      approvedPriceCents: plan.approvedPriceCents,
      plan: plan.plan,
    },
  });
  // A planned offer leaves the ordinary reply free to read any other pending offer. A
  // pending plan offer is this lane's alone: the one-shot sign-up must never book it.
  if (!reading || reading.verdict === 'unrelated') {
    return plan.status === 'pending' ? unclaimed() : null;
  }

  if (reading.verdict === 'unclear') {
    return reply(database, input, deps, plan, 'clarify', { question: reading.question });
  }

  if (reading.verdict === 'take_back') {
    if (plan.status === 'pending') {
      await markOffer(database, {
        offerId: plan.offerId,
        familyId: input.familyId,
        from: 'pending',
        status: 'handed_back',
        messageId: input.inboundChannelMessageId,
        now: input.now,
      });
      return reply(database, input, deps, plan, 'declined', {});
    }
    const cancelled = await cancelSignupPlan(database, {
      offerId: plan.offerId,
      familyId: input.familyId,
      actor: input.parentUserId,
      now: input.now,
    });
    // Gone between the read and now. Or already paying: the take-back is marked, and the
    // sweep tells the parent what the payment did; this lane does not say it was cancelled.
    if (cancelled === 'not_planned' || cancelled === 'paying') return null;
    return reply(database, input, deps, plan, 'cancelled', {});
  }

  if (deps.declineSeat && (await deps.declineSeat())) {
    return {
      claimed: true,
      outcome: 'group_member_not_authorized',
      reply: null,
      deliverOnThread: false,
    };
  }
  if (!input.inboundChannelMessageId) {
    return reply(database, input, deps, plan, 'refused', { refusal: 'not_stored' });
  }
  if (plan.status === 'pending') {
    const identity = await loadSignupIdentity(database, {
      familyId: input.familyId,
      childId: plan.childId,
      parentUserId: input.parentUserId,
      now: input.now,
    });
    if (identity && identity.childDob === null) {
      const asked = await hasPlanNotice(database, plan.offerId, 'ask_dob');
      if (!asked) {
        const host = signupProviderHost(new URL(plan.registrationUrl).hostname);
        await recordPlanNotice(database, {
          familyId: input.familyId,
          offerId: plan.offerId,
          providerHost: host,
          kind: 'ask_dob',
          now: input.now,
        });
        await writePlanAudit(database, {
          familyId: input.familyId,
          actor: input.parentUserId,
          offerId: plan.offerId,
          after: { step: 'plan_ask_dob', host },
        });
        return reply(database, input, deps, plan, 'clarify', {
          question: "What is the child's date of birth?",
        });
      }
    }
  }
  const approved = await approveSignupPlan(database, {
    offerId: plan.offerId,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    messageId: input.inboundChannelMessageId,
    choiceIds: reading.choiceIds,
    maxPriceCents: reading.maxPriceCents,
    opensAt: plan.opensAt,
    waiverAccepted: reading.waiverAccepted,
    alreadyOpen: plan.alreadyOpen,
    now: input.now,
  });
  if (!approved.ok) {
    return reply(database, input, deps, plan, 'refused', { refusal: approved.reason });
  }
  return reply(database, input, deps, plan, 'approved', {
    choiceIds: reading.choiceIds,
    maxPriceCents: reading.maxPriceCents,
    waiverAccepted: reading.waiverAccepted,
  });
}

async function runMismatchTurn(
  database: Database,
  input: SignupRunInput,
  deps: PlanTurnDeps,
  plan: ConversablePlan,
): Promise<SignupRunResult> {
  const rawChoices = plan.availability?.choices;
  const parsed = Array.isArray(rawChoices)
    ? rawChoices.flatMap((row) => {
        const item = siteChoiceSchema.safeParse(row);
        return item.success ? [item.data] : [];
      })
    : [];
  const askedStart =
    typeof plan.availability?.askedStart === 'string' ? plan.availability.askedStart : null;
  const reader = deps.mismatchReader ?? createMismatchReader(() => resolveReplyClient(undefined));
  const reading = await reader.read({ text: input.body, askedStart, choices: parsed });
  if (!reading || reading.verdict === 'unrelated') return unclaimed();
  if (reading.verdict === 'unclear') {
    return reply(database, input, deps, plan, 'clarify', { question: reading.question });
  }
  if (reading.verdict === 'waitlist') {
    await parkSignupPlan(database, {
      offerId: plan.offerId,
      familyId: input.familyId,
      availability: { kind: 'join_waitlist', askedStart, choices: parsed },
      now: input.now,
    });
    return reply(database, input, deps, plan, 'approved', {});
  }
  if (reading.verdict === 'option') {
    const choice = parsed.find((item) => item.id === reading.choiceId);
    await parkSignupPlan(database, {
      offerId: plan.offerId,
      familyId: input.familyId,
      availability: { kind: 'take_option', choice, askedStart, choices: parsed },
      now: input.now,
    });
    return reply(database, input, deps, plan, 'approved', {});
  }
  const to = parsed
    .map((item) => item.provider_email)
    .find((email): email is string => Boolean(email));
  if (!to || !deps.sendProviderEmail) {
    return reply(database, input, deps, plan, 'clarify', {
      question: 'Hale does not have an email address for this provider on the page.',
    });
  }
  await deps.sendProviderEmail({
    familyId: input.familyId,
    actorUserId: input.parentUserId,
    to,
    subject: askedStart ? `Start date ${askedStart}` : 'Start date',
    body: [
      askedStart
        ? `The parent asked for a ${askedStart} start.`
        : 'The parent asked for a later start.',
      `The site currently offers: ${parsed.map((item) => item.label).join('; ')}.`,
      'Could you add the start they asked for?',
    ].join(' '),
  });
  await parkSignupPlan(database, {
    offerId: plan.offerId,
    familyId: input.familyId,
    availability: { kind: 'emailed', askedStart, choices: parsed },
    now: input.now,
  });
  return reply(database, input, deps, plan, 'approved', {});
}

function unclaimed(): SignupRunResult {
  return { claimed: false, outcome: 'not_claimed', reply: null, deliverOnThread: false };
}

const OUTCOME: Record<Exclude<PlanReplyMoment, 'offer' | 'run_finished'>, string> = {
  approved: 'plan_approved',
  cancelled: 'plan_cancelled',
  declined: 'plan_declined',
  clarify: 'plan_clarify',
  refused: 'plan_refused',
};

export function replySessions(sessions: readonly SignupSession[]): PlanReplySession[] {
  return sessions.map((session) => ({
    label: session.label,
    startsAt: session.startsAt,
    endsAt: session.endsAt,
    priceCents: session.priceCents,
  }));
}

/** The parent's own zone: a stored `UTC` default is restated as UTC, never guessed. */
export async function parentTimeZone(database: Database, parentUserId: string): Promise<string> {
  const [user] = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, parentUserId))
    .limit(1);
  if (!user) throw new Error('a plan parent has no user row');
  return user.timezone;
}

export async function childFirstName(
  database: Database,
  input: { familyId: string; childId: string },
): Promise<string | null> {
  const [child] = await database
    .select({ name: schema.children.name })
    .from(schema.children)
    .where(and(eq(schema.children.id, input.childId), eq(schema.children.familyId, input.familyId)))
    .limit(1);
  return child?.name ?? null;
}

async function reply(
  database: Database,
  input: SignupRunInput,
  deps: PlanTurnDeps,
  plan: ConversablePlan,
  moment: Exclude<PlanReplyMoment, 'offer' | 'run_finished'>,
  extra: {
    question?: string;
    refusal?: string;
    choiceIds?: readonly string[];
    maxPriceCents?: number;
    waiverAccepted?: boolean;
  },
): Promise<SignupRunResult> {
  const choices = extra.choiceIds
    ? extra.choiceIds.flatMap((id) => plan.sessions.filter((s) => s.id === id))
    : plan.sessions;
  const facts: PlanReplyFacts = {
    moment,
    mode: planReplyMode(plan.registrationUrl),
    childFirstName: await childFirstName(database, {
      familyId: input.familyId,
      childId: plan.childId,
    }),
    opensAt: planOpensAtLocal(plan.opensAt, await parentTimeZone(database, input.parentUserId)),
    sessions: replySessions(choices),
    maxPriceCents: extra.maxPriceCents ?? plan.plan?.maxPriceCents ?? null,
    waiverAccepted: extra.waiverAccepted ?? plan.plan?.waiverAccepted ?? null,
    question: extra.question ?? null,
    refusal: extra.refusal ?? null,
    run: null,
    language: await readParentLanguage(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
    }),
  };
  const writer = deps.planWriter ?? createPlanReplyWriter(() => resolveReplyClient(undefined));
  const text = await writer.write(facts);
  const outcome = OUTCOME[moment];
  await writePlanAudit(database, {
    familyId: input.familyId,
    actor: input.parentUserId,
    offerId: plan.offerId,
    after: { step: 'plan_reply', moment, refusal: extra.refusal ?? null, replied: text !== null },
  });
  if (text === null) {
    console.warn({ outcome }, 'signup plans: reply unwritten');
    return {
      claimed: true,
      outcome,
      reply: null,
      deliverOnThread: false,
      unsent: 'reply_unwritten',
    };
  }
  const link = moment === 'refused' ? plan.registrationUrl : null;
  return { claimed: true, outcome, reply: planReplyBody(text, link), deliverOnThread: true };
}
