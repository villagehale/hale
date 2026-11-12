import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { readParentLanguage } from '~/lib/channel/parent-language';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import {
  type AskPlace,
  PICK_ASK_BACK_QUESTION,
  PLAN_ASK_BACK_QUESTION,
  stoppedTurn,
} from '../asks';
import { signupProviderHost } from '../consent';
import { namesFacts } from '../parent-quote';
import type { SignupRunInput, SignupRunResult } from '../run';
import { type SiteChoice, siteChoiceSchema } from '../site-choices';
import { askStamp, loadSignupIdentity, markOffer } from '../store';
import type { SignupSession } from '../types';
import { registrationMismatchPlanEnabled } from './flag';
import { type MismatchReader, type MismatchReading, createMismatchReader } from './mismatch-reader';
import { hasPlanNotice, recordPlanNotice } from './prep';
import {
  type ProviderEmailBlocked,
  type ProviderEmailDrafter,
  productionProviderEmailDrafter,
} from './provider-email';
import {
  type PlanNaming,
  type PlanReader,
  type PlanReading,
  createPlanReader,
  untrustedActivityLabel,
} from './reader';
import {
  type ConversablePlan,
  approveSignupPlan,
  cancelSignupPlan,
  parkSignupPlan,
  writePlanAudit,
} from './store';
import { planReplyMode } from './towns';
import {
  type PlanReplyFacts,
  type PlanReplyMoment,
  type PlanReplySession,
  type PlanReplySiteChoice,
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
  /**
   * Lit (`registration-mismatch-plan`): leaves the provider email as a draft in the parent's
   * Gmail. Undefined uses the reply model and the parent's Gmail connection.
   */
  providerEmail?: ProviderEmailDrafter;
  /** Dark only: sends the provider email from the parent's Gmail after they say yes. */
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
 * How a plan turn bound this ask: it was the parent's newest (`newest`), or their words
 * named it (`tokens`: see {@link PlanNaming}). Recorded on the reply audit row.
 */
type PlanBinding = 'newest' | PlanNaming;

/**
 * The ask Hale asked last takes the parent's words unnamed; any other only words that name
 * it, and then only as far as a question back.
 */
function binding(newest: boolean, named: PlanNaming | null): PlanBinding | null {
  return newest ? 'newest' : named;
}

/**
 * VIL-558 · the day-before plan conversation, for one plan ask among the live asks Hale
 * made this parent (`loadLiveAsks`, which holds only their own; the walk over them is
 * `runAuthorizedSignup`). A model reads the parent's words ({@link PlanReader}); a yes calls
 * `approveSignupPlan`, a take-back calls `cancelSignupPlan` (or closes the offer when it was
 * never approved). Every claimed turn writes one audit row and a model-written reply.
 *
 * `unrelated` hands the message to the next ask, of either lane. A yes or take-back moves
 * only the ask Hale asked the parent about last, whatever its status: a yes to that plan once
 * it is approved reads as unrelated, and no other ask takes it. Words that name another plan
 * (its program or site) never move it: Hale asks about it instead, and once that question
 * went out it is the ask asked last, so the parent's next answer is its. A yes or take-back
 * that does not name a plan Hale did not ask last stops the turn, and so does a reading that
 * failed: it is never carried on to the next ask. Nothing moves, and nothing is asked, from a
 * group seat that may not authorize a sign-up. A stopped turn is unclaimed, logged and named.
 */
export async function runPlanAsk(
  database: Database,
  input: SignupRunInput,
  deps: PlanTurnDeps,
  plan: ConversablePlan,
  place: AskPlace,
): Promise<SignupRunResult | 'unrelated'> {
  const parkedKind = plan.availability?.kind;
  if (
    parkedKind === 'options_mismatch' ||
    (parkedKind === 'emailed' && registrationMismatchPlanEnabled(input.familyId))
  ) {
    return runMismatchTurn(database, input, deps, plan, place);
  }
  const reader = deps.planReader ?? createPlanReader(() => resolveReplyClient(undefined));
  const reading: PlanReading | null = await reader.read({
    text: input.body,
    offer: {
      // A running plan is the approved plan to its reader: it can only be taken back.
      status: plan.status === 'running' ? 'planned' : plan.status,
      activity: plan.activityLabel,
      host: plan.providerHost,
      opensAt: plan.opensAt,
      sessions: plan.sessions,
      approvedPriceCents: plan.approvedPriceCents,
      plan: plan.plan,
      asksWaiver: await hasPlanNotice(database, plan.offerId, 'ask_waiver'),
    },
  });
  if (!reading) return stopped('plan_unread', plan);
  if (reading.verdict === 'unrelated') return 'unrelated';

  if (reading.verdict === 'unclear') {
    // A question back about an older plan its words never named would leave the parent's
    // next bare yes to the newest ask: it passes on instead.
    const boundBy = binding(place.newest, reading.named);
    if (!boundBy) return 'unrelated';
    return reply(database, input, deps, plan, 'clarify', { question: reading.question, boundBy });
  }

  const boundBy = binding(place.newest, reading.named);
  if (!boundBy) return stopped('plan_unnamed', plan);
  if (deps.declineSeat && (await deps.declineSeat())) return groupSeatDeclined();
  if (!place.newest) {
    return reply(database, input, deps, plan, 'clarify', {
      question: PLAN_ASK_BACK_QUESTION,
      boundBy,
    });
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
      return reply(database, input, deps, plan, 'declined', { boundBy });
    }
    const cancelled = await cancelSignupPlan(database, {
      offerId: plan.offerId,
      familyId: input.familyId,
      actor: input.parentUserId,
      now: input.now,
    });
    // Gone between the read and now. Or already paying: the take-back is marked, and the
    // sweep tells the parent what the payment did; this lane does not say it was cancelled.
    if (cancelled === 'not_planned' || cancelled === 'paying') {
      return {
        claimed: false,
        outcome: cancelled === 'paying' ? 'plan_cancel_paying' : 'plan_not_planned',
        reply: null,
        deliverOnThread: false,
      };
    }
    return reply(database, input, deps, plan, 'cancelled', { boundBy });
  }

  if (!input.inboundChannelMessageId) {
    return reply(database, input, deps, plan, 'refused', { refusal: 'not_stored', boundBy });
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
          boundBy,
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
    return reply(database, input, deps, plan, 'refused', { refusal: approved.reason, boundBy });
  }
  return reply(database, input, deps, plan, 'approved', {
    choiceIds: reading.choiceIds,
    maxPriceCents: reading.maxPriceCents,
    waiverAccepted: reading.waiverAccepted,
    boundBy,
  });
}

/**
 * A pick among the site's options, for a plan whose options did not match. A pick parks or
 * emails only for the parent's newest ask. The mismatch reader is never shown the program,
 * so any other plan is reached only by a message that names it, in whole words checked in
 * code, and then Hale asks for the pick instead of making it.
 */
async function runMismatchTurn(
  database: Database,
  input: SignupRunInput,
  deps: PlanTurnDeps,
  plan: ConversablePlan,
  place: AskPlace,
): Promise<SignupRunResult | 'unrelated'> {
  const rawChoices = plan.availability?.choices;
  const parsed = Array.isArray(rawChoices)
    ? rawChoices.flatMap((row) => {
        const item = siteChoiceSchema.safeParse(row);
        return item.success ? [item.data] : [];
      })
    : [];
  const askedStart =
    typeof plan.availability?.askedStart === 'string' ? plan.availability.askedStart : null;
  const lit = registrationMismatchPlanEnabled(input.familyId);
  const emailed = plan.availability?.kind === 'emailed';
  const reader = deps.mismatchReader ?? createMismatchReader(() => resolveReplyClient(undefined));
  const reading = await reader.read({
    text: input.body,
    askedStart,
    choices: parsed,
    ...(emailed ? { emailed: true as const } : {}),
  });
  if (!reading) return stopped('plan_unread', plan);
  // Dark, the lane has no retry: a reading it cannot act on is one that failed.
  if (!lit && reading.verdict === 'retry') return stopped('plan_unread', plan);
  if (reading.verdict === 'unrelated') return 'unrelated';
  const named = namesFacts(input.body, {
    activity: untrustedActivityLabel(plan.activityLabel),
    host: plan.providerHost,
  });
  const boundBy = binding(place.newest, named ? 'tokens' : null);
  if (reading.verdict === 'unclear') {
    if (!boundBy) return 'unrelated';
    return reply(database, input, deps, plan, 'clarify', { question: reading.question, boundBy });
  }
  if (!boundBy) return stopped('plan_unnamed', plan);
  // A pick parks the plan or emails the provider from the parent's Gmail: never from a
  // group seat that may not authorize a sign-up, as for any other ask.
  if (deps.declineSeat && (await deps.declineSeat())) return groupSeatDeclined();
  if (!place.newest) {
    return reply(database, input, deps, plan, 'clarify', {
      question: PICK_ASK_BACK_QUESTION,
      boundBy,
    });
  }
  if (lit) {
    return runMismatchPick(database, input, deps, plan, {
      reading,
      choices: parsed,
      askedStart,
      boundBy,
    });
  }
  if (reading.verdict === 'waitlist') {
    await parkSignupPlan(database, {
      offerId: plan.offerId,
      familyId: input.familyId,
      availability: { kind: 'join_waitlist', askedStart, choices: parsed },
      now: input.now,
    });
    return reply(database, input, deps, plan, 'approved', { boundBy });
  }
  if (reading.verdict === 'option') {
    const choice = parsed.find((item) => item.id === reading.choiceId);
    await parkSignupPlan(database, {
      offerId: plan.offerId,
      familyId: input.familyId,
      availability: { kind: 'take_option', choice, askedStart, choices: parsed },
      now: input.now,
    });
    return reply(database, input, deps, plan, 'approved', { boundBy });
  }
  const to = parsed
    .map((item) => item.provider_email)
    .find((email): email is string => Boolean(email));
  if (!to || !deps.sendProviderEmail) {
    return reply(database, input, deps, plan, 'clarify', {
      question: 'Hale does not have an email address for this provider on the page.',
      boundBy,
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
  return reply(database, input, deps, plan, 'approved', { boundBy });
}

type MismatchPick = Exclude<MismatchReading, { verdict: 'unclear' } | { verdict: 'unrelated' }>;

/**
 * Lit (`registration-mismatch-plan`) · the parent's pick, bound to their newest ask by
 * `runMismatchTurn`. Each pick writes one audit row of its own and gets its own reply:
 *
 * - a waitlist (or an option the site marks as one) and a site option are parked for the next
 *   sweep as a register-now run, since the site was already seen open;
 * - `retry` (the provider fixed it) parks the original plan the same way;
 * - `email` writes the provider email, tells the parent, then leaves it as a DRAFT in their
 *   Gmail for them to send. Any reason Hale cannot (no address on the page, no Gmail
 *   connected, Google said no) is said in the model's words, and the other picks stay open.
 */
async function runMismatchPick(
  database: Database,
  input: SignupRunInput,
  deps: PlanTurnDeps,
  plan: ConversablePlan,
  read: {
    reading: MismatchPick;
    choices: SiteChoice[];
    askedStart: string | null;
    boundBy: PlanBinding;
  },
): Promise<SignupRunResult> {
  const { reading, choices, askedStart, boundBy } = read;
  const messageId = input.inboundChannelMessageId;
  if (!messageId) {
    return reply(database, input, deps, plan, 'refused', { refusal: 'not_stored', boundBy });
  }
  const choice =
    reading.verdict === 'waitlist' || reading.verdict === 'option'
      ? (choices.find((item) => item.id === reading.choiceId) ?? null)
      : null;
  if (reading.verdict === 'option' && !choice) return stopped('plan_unread', plan);
  // `blocked`, never a key the audit redaction drops (anything named like an email).
  const picked = (after: { drafted?: boolean; blocked?: ProviderEmailBlocked } = {}) =>
    writePlanAudit(database, {
      familyId: input.familyId,
      actor: input.parentUserId,
      offerId: plan.offerId,
      after: {
        step: 'plan_mismatch_pick',
        verdict: reading.verdict,
        choiceId: choice?.id ?? null,
        messageId,
        host: plan.providerHost,
        ...after,
      },
    });
  const park = (availability: Record<string, unknown>) =>
    parkSignupPlan(database, {
      offerId: plan.offerId,
      familyId: input.familyId,
      availability,
      now: input.now,
      resumeNow: true,
    });

  if (reading.verdict === 'waitlist' || (reading.verdict === 'option' && choice?.waitlist)) {
    await park({ kind: 'join_waitlist', choice, askedStart, choices });
    await picked();
    return reply(database, input, deps, plan, 'join_waitlist', {
      boundBy,
      ...(choice ? { siteChoice: replySiteChoice(choice) } : {}),
    });
  }
  if (reading.verdict === 'option' && choice) {
    await park({ kind: 'take_option', choice, askedStart, choices });
    await picked();
    return reply(database, input, deps, plan, 'take_option', {
      boundBy,
      siteChoice: replySiteChoice(choice),
    });
  }
  if (reading.verdict === 'retry') {
    await park({ kind: 'retry', askedStart, choices });
    await picked();
    return reply(database, input, deps, plan, 'approved', { boundBy, alreadyOpen: true });
  }

  // Asked again once the draft exists: it is still in their Drafts, and no second one is written.
  if (plan.availability?.kind === 'emailed') {
    await picked({ drafted: false });
    return reply(database, input, deps, plan, 'emailed', { boundBy });
  }
  const unavailable = async (reason: ProviderEmailBlocked) => {
    await picked({ drafted: false, blocked: reason });
    return reply(database, input, deps, plan, 'email_unavailable', {
      boundBy,
      emailBlocked: reason,
      siteChoices: choices.map(replySiteChoice),
    });
  };
  const to = choices.map((item) => item.provider_email).find((email) => Boolean(email)) ?? null;
  const drafter = deps.providerEmail ?? productionProviderEmailDrafter(database);
  const ready = await drafter.readiness({
    familyId: input.familyId,
    actorUserId: input.parentUserId,
    to,
  });
  if (!ready.ok) return unavailable(ready.reason);
  if (!to) return unavailable('no_provider_email');
  const draft = await drafter.write({
    childFirstName: await childFirstName(database, {
      familyId: input.familyId,
      childId: plan.childId,
    }),
    activity: plan.activityLabel,
    askedStart,
    siteChoices: choices.map((item) => ({
      label: item.label,
      startsAt: item.starts_at,
      waitlist: item.waitlist,
    })),
  });
  if (!draft) return unavailable('unwritten');
  // The parent is told before the draft exists: no draft is ever one nobody was told about.
  const told = await writeReply(database, input, deps, plan, 'emailed', {});
  if (told.text === null) {
    return replied(database, input, plan, 'emailed', { boundBy }, told.text);
  }
  const committed = await drafter.commit({
    familyId: input.familyId,
    actorUserId: input.parentUserId,
    to,
    subject: draft.subject,
    body: draft.body,
  });
  if (committed.status === 'blocked') return unavailable(committed.reason);
  await parkSignupPlan(database, {
    offerId: plan.offerId,
    familyId: input.familyId,
    availability: { kind: 'emailed', draftId: committed.draftId, askedStart, choices },
    now: input.now,
  });
  await picked({ drafted: true });
  return replied(database, input, plan, 'emailed', { boundBy }, told.text);
}

function replySiteChoice(choice: SiteChoice): PlanReplySiteChoice {
  return {
    label: choice.label,
    startsAt: choice.starts_at,
    priceCents: choice.price_cents,
    billingNote: choice.billing_note,
    waitlist: choice.waitlist,
  };
}

function stopped(outcome: 'plan_unread' | 'plan_unnamed', plan: ConversablePlan): SignupRunResult {
  return stoppedTurn(outcome, { offerId: plan.offerId, status: plan.status });
}

/** A sender whose group seat may not authorize a sign-up moves no plan, and hears nothing. */
function groupSeatDeclined(): SignupRunResult {
  return {
    claimed: true,
    outcome: 'group_member_not_authorized',
    reply: null,
    deliverOnThread: false,
  };
}

const OUTCOME: Record<Exclude<PlanReplyMoment, 'offer' | 'run_finished'>, string> = {
  approved: 'plan_approved',
  cancelled: 'plan_cancelled',
  declined: 'plan_declined',
  clarify: 'plan_clarify',
  refused: 'plan_refused',
  join_waitlist: 'plan_waitlist_chosen',
  take_option: 'plan_option_chosen',
  emailed: 'plan_email_drafted',
  email_unavailable: 'plan_email_unavailable',
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

type ReplyMoment = Exclude<PlanReplyMoment, 'offer' | 'run_finished'>;

interface ReplyExtra {
  question?: string;
  refusal?: string;
  choiceIds?: readonly string[];
  maxPriceCents?: number;
  waiverAccepted?: boolean;
  boundBy?: PlanBinding;
  alreadyOpen?: true;
  siteChoice?: PlanReplySiteChoice;
  siteChoices?: readonly PlanReplySiteChoice[];
  emailBlocked?: ProviderEmailBlocked;
}

async function reply(
  database: Database,
  input: SignupRunInput,
  deps: PlanTurnDeps,
  plan: ConversablePlan,
  moment: ReplyMoment,
  extra: ReplyExtra,
): Promise<SignupRunResult> {
  const { text } = await writeReply(database, input, deps, plan, moment, extra);
  return replied(database, input, plan, moment, extra, text);
}

/** The model's text for this moment, or null: nothing is said yet. */
async function writeReply(
  database: Database,
  input: SignupRunInput,
  deps: PlanTurnDeps,
  plan: ConversablePlan,
  moment: ReplyMoment,
  extra: ReplyExtra,
): Promise<{ text: string | null }> {
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
    // Lit, a plan registering now names no open time.
    ...(extra.alreadyOpen || (plan.alreadyOpen && registrationMismatchPlanEnabled(input.familyId))
      ? { alreadyOpen: true as const }
      : {}),
    ...(extra.siteChoice ? { siteChoice: extra.siteChoice } : {}),
    ...(extra.siteChoices ? { siteChoices: extra.siteChoices } : {}),
    ...(extra.emailBlocked ? { emailBlocked: extra.emailBlocked } : {}),
  };
  const writer = deps.planWriter ?? createPlanReplyWriter(() => resolveReplyClient(undefined));
  return { text: await writer.write(facts) };
}

/** One audit row for the reply, and the turn's result: the text, or why nothing is sent. */
async function replied(
  database: Database,
  input: SignupRunInput,
  plan: ConversablePlan,
  moment: ReplyMoment,
  extra: ReplyExtra,
  text: string | null,
): Promise<SignupRunResult> {
  const outcome = OUTCOME[moment];
  await writePlanAudit(database, {
    familyId: input.familyId,
    actor: input.parentUserId,
    offerId: plan.offerId,
    after: {
      step: 'plan_reply',
      moment,
      refusal: extra.refusal ?? null,
      replied: text !== null,
      boundBy: extra.boundBy ?? null,
    },
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
  return {
    claimed: true,
    outcome,
    reply: planReplyBody(text, link),
    deliverOnThread: true,
    stamp: askStamp(database, {
      familyId: input.familyId,
      parentUserId: input.parentUserId,
      offerIds: [plan.offerId],
    }),
  };
}
