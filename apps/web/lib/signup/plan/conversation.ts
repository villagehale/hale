import { type Database, schema } from '@hale/db';
import { and, eq } from 'drizzle-orm';
import { entitlementsForFamily } from '~/lib/billing/max-entitlements';
import { parentSeasonClock } from '~/lib/channel/family-tz';
import { readParentLanguage } from '~/lib/channel/parent-language';
import { resolveReplyClient } from '~/lib/channel/reply-copy/client';
import { pageOps } from '~/lib/monitoring/failure-page';
import {
  type AskPlace,
  PICK_ASK_BACK_QUESTION,
  PLAN_ASK_BACK_QUESTION,
  stoppedTurn,
} from '../asks';
import { signupProviderHost } from '../consent';
import { namesFacts } from '../parent-quote';
import type { SignupRunInput, SignupRunResult } from '../run';
import { claimSignupHelpAttempt, releaseSignupHelpAttempt } from '../signup-help-season';
import { type SiteChoice, siteChoiceSchema } from '../site-choices';
import { askStamp, loadSignupIdentity, markOffer, recordSignupOffer } from '../store';
import {
  boundPriceCents,
  childFor,
  planReadTerms,
  taxBoundFor,
  termsTimeZone,
  writerTerms,
} from '../terms/ask';
import { bindApproval } from '../terms/bind';
import { type DobReader, acceptDobReading, createDobReader } from '../terms/dob-reader';
import { ageFitFromRule } from '../terms/evaluate';
import { registrationPreflightEnabled } from '../terms/flag';
import {
  type SignupTermsRead,
  type SignupTermsRow,
  askIsOnTerms,
  loadSignupTerms,
  prerequisiteAskStamp,
  priorChargeUnknown,
  termsAskStamp,
} from '../terms/store';
import type { SignupTermsShown } from '../terms/types';
import type { SignupSession } from '../types';
import { type MismatchReader, createMismatchReader } from './mismatch-reader';
import { hasPlanNotice, recordPlanNotice } from './prep';
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
  type PlanReplyTerms,
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
  /** VIL-715 · reads a date of birth from a reply to Hale's ask for it. */
  dobReader?: DobReader;
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
 * Whether the parent's answer moves this plan rather than making Hale ask about it: it is
 * their newest ask, or the sign-up ask Hale asked about last and their own words name it in
 * whole words while only an open question outranks it (`AskPlace.laneNewest`).
 */
function binds(place: AskPlace, named: PlanNaming | null): boolean {
  return place.newest || (place.laneNewest && named === 'tokens');
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
  if (plan.availability && plan.availability.kind === 'options_mismatch') {
    return runMismatchTurn(database, input, deps, plan, place);
  }
  // VIL-715: a pending ask that has terms is read, and bound, against them, whatever the flag
  // says now. The flag decides only what a new ask is, and what an ask with no row does.
  const termsRead =
    plan.status === 'pending'
      ? await loadSignupTerms(database, { offerId: plan.offerId, familyId: input.familyId })
      : null;
  const terms = termsRead?.status === 'read' ? termsRead.row : null;
  // A seat that may not authorize a sign-up answers no question about the child either.
  if (terms && place.newest && !(deps.declineSeat && (await deps.declineSeat()))) {
    const answered = await runDobTurn(database, input, deps, plan, terms);
    if (answered) return answered;
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
      ...(terms
        ? {
            terms: planReadTerms(terms.shown, {
              prerequisiteAsked:
                terms.prerequisiteAskedSeq !== null &&
                terms.prerequisiteAskedSeq === plan.lastAskedSeq,
            }),
          }
        : {}),
    },
  });
  if (!reading) return stopped('plan_unread', plan);
  if (reading.verdict === 'unrelated') return 'unrelated';

  if (reading.verdict === 'unclear') {
    // A question back about an older plan its words never named would leave the parent's
    // next bare yes to the newest ask: it passes on instead.
    const boundBy = binding(place.newest, reading.named);
    if (!boundBy) return 'unrelated';
    // The question may be whether Hale can pay the stated price, so the writer needs it. A
    // seat that may not authorize this sign-up is not told a price.
    const statesPrice = terms && !(deps.declineSeat && (await deps.declineSeat()));
    return reply(database, input, deps, plan, 'clarify', {
      question: reading.question,
      boundBy,
      ...(statesPrice ? { terms: writerTerms(terms.shown) } : {}),
    });
  }

  const boundBy = binding(place.newest, reading.named);
  if (!boundBy) return stopped('plan_unnamed', plan);
  if (deps.declineSeat && (await deps.declineSeat())) return groupSeatDeclined();
  if (!binds(place, reading.named)) {
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
  if (
    termsRead !== null &&
    (termsRead.status !== 'none' || registrationPreflightEnabled(input.familyId))
  ) {
    return approveOnTerms(database, input, deps, plan, termsRead, reading, boundBy);
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

/** Asked once a date of birth is in: a date is not a yes. */
const TERMS_CONFIRM_QUESTION = 'Now that Hale has the date of birth, should it go ahead?';
const TERMS_AMOUNT_QUESTION = 'What is the most Hale may pay for this?';
const TERMS_DOB_OTHER_QUESTION =
  "The date they gave is someone else's. What is this child's date of birth?";
const TERMS_DOB_UNCLEAR_QUESTION =
  "The date they gave could not be read for certain. What is this child's date of birth, with the month written out?";
const termsPrerequisiteQuestion = (quote: string | null) =>
  quote
    ? `The class says: "${quote}". Has the child done that?`
    : 'The class needs something first. Has the child done it?';

async function childAgeRow(database: Database, familyId: string, childId: string) {
  const [child] = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
      dobPrecision: schema.children.dobPrecision,
    })
    .from(schema.children)
    .where(and(eq(schema.children.id, childId), eq(schema.children.familyId, familyId)))
    .limit(1);
  return child ?? null;
}

async function termsZone(database: Database, plan: ConversablePlan, parentUserId: string) {
  const host = new URL(plan.registrationUrl).hostname;
  return termsTimeZone(host, await parentTimeZone(database, parentUserId));
}

/**
 * VIL-715 · while Hale's ask for a date of birth stands, a reply that states this child's
 * is stored as the exact date, in the parent's own words, and the age check runs again. A
 * child now outside the band closes the offer. Otherwise Hale asks them to confirm. A date
 * given for someone else is stored nowhere, and Hale asks for this child's. Null: no date
 * in this message, and the turn goes on as usual.
 */
async function runDobTurn(
  database: Database,
  input: SignupRunInput,
  deps: PlanTurnDeps,
  plan: ConversablePlan,
  terms: SignupTermsRow,
): Promise<SignupRunResult | null> {
  if (!(await hasPlanNotice(database, plan.offerId, 'ask_dob'))) return null;
  const child = await childAgeRow(database, input.familyId, plan.childId);
  if (!child || child.dobPrecision === 'exact') return null;
  const reader = deps.dobReader ?? createDobReader(() => resolveReplyClient(undefined));
  const raw = await reader.read({ text: input.body, childFirstName: child.name });
  if (raw?.otherPerson) {
    return reply(database, input, deps, plan, 'clarify', {
      question: TERMS_DOB_OTHER_QUESTION,
      boundBy: 'newest',
    });
  }
  const date = raw ? acceptDobReading(raw, input.body, input.now) : null;
  if (date === null && raw?.date) {
    return reply(database, input, deps, plan, 'clarify', {
      question: TERMS_DOB_UNCLEAR_QUESTION,
      boundBy: 'newest',
    });
  }
  if (date === null) return null;
  await database
    .update(schema.children)
    .set({ dateOfBirth: date, dobPrecision: 'exact', updatedAt: input.now })
    .where(and(eq(schema.children.id, child.id), eq(schema.children.familyId, input.familyId)));
  await writePlanAudit(database, {
    familyId: input.familyId,
    actor: input.parentUserId,
    offerId: plan.offerId,
    after: { step: 'plan_dob_recorded', host: plan.providerHost },
  });
  const rule = terms.shown.age.rule;
  const fit = rule
    ? ageFitFromRule(
        rule,
        { id: child.id, dateOfBirth: date, dobPrecision: 'exact' },
        { now: input.now, timeZone: await termsZone(database, plan, input.parentUserId) },
      )
    : 'unknown';
  if (fit === 'outside_band') {
    await markOffer(database, {
      offerId: plan.offerId,
      familyId: input.familyId,
      from: 'pending',
      status: 'handed_back',
      messageId: input.inboundChannelMessageId,
      now: input.now,
    });
    return reply(database, input, deps, plan, 'refused', {
      refusal: 'age_outside_band',
      terms: writerTerms(terms.shown),
      noLink: true,
      boundBy: 'newest',
    });
  }
  return reply(database, input, deps, plan, 'clarify', {
    question: TERMS_CONFIRM_QUESTION,
    boundBy: 'newest',
  });
}

/** A season slot for an ask that counts, claimed before the plan can run. */
async function claimSeasonSlot(
  database: Database,
  input: SignupRunInput,
): Promise<{ ok: true; seasonKey: string | null } | { ok: false }> {
  const [family] = await database
    .select({ planTier: schema.families.planTier })
    .from(schema.families)
    .where(eq(schema.families.id, input.familyId))
    .limit(1);
  const cap = entitlementsForFamily(family?.planTier ?? 'free').signupHelpPerSeason;
  if (cap === null) return { ok: true, seasonKey: null };
  const clock = await parentSeasonClock(database, input.parentUserId, input.now);
  if (clock.outcome !== 'season') {
    console.info({ outcome: 'timezone_unset' }, 'signup plans: season cap not claimed, zone unset');
    return { ok: true, seasonKey: null };
  }
  const claim = await claimSignupHelpAttempt(database, {
    familyId: input.familyId,
    seasonKey: clock.key,
    cap,
    now: input.now,
  });
  return claim.ok ? { ok: true, seasonKey: clock.key } : { ok: false };
}

/**
 * VIL-715 · the parent's yes to an ask that has terms. The yes binds only what Hale showed
 * them, and only once it reached them. A plan is stored with its approval in one
 * transaction; no run starts on this turn, so the reply is the ack and the sweep does the
 * work. An ask with no stored terms (made before the flag) is never bound: it goes back
 * with the link.
 */
async function approveOnTerms(
  database: Database,
  input: SignupRunInput,
  deps: PlanTurnDeps,
  plan: ConversablePlan,
  termsRead: SignupTermsRead,
  reading: Extract<PlanReading, { verdict: 'approve' }>,
  boundBy: PlanBinding,
): Promise<SignupRunResult> {
  const messageId = input.inboundChannelMessageId as string;
  if (termsRead.status !== 'read') {
    await markOffer(database, {
      offerId: plan.offerId,
      familyId: input.familyId,
      from: 'pending',
      status: 'handed_back',
      messageId,
      now: input.now,
    });
    return reply(database, input, deps, plan, 'refused', { refusal: 'no_terms', boundBy });
  }
  const { askedMessageId } = termsRead.row;
  // An earlier run may have ended with an unknown charge since the ask was made.
  const shown: SignupTermsShown = {
    ...termsRead.row.shown,
    priorChargeUnknown:
      termsRead.row.shown.priorChargeUnknown ||
      (await priorChargeUnknown(database, {
        familyId: input.familyId,
        childId: plan.childId,
        activityKey: plan.activityKey,
      })),
  };
  const child = await childAgeRow(database, input.familyId, plan.childId);
  if (!child) {
    return reply(database, input, deps, plan, 'refused', { refusal: 'missing_detail', boundBy });
  }
  const timeZone = await termsZone(database, plan, input.parentUserId);
  const bound = bindApproval({
    shown,
    askedMessageId,
    sessions: plan.sessions,
    activityLabel: plan.activityLabel,
    choiceIds: reading.choiceIds,
    ceilingCents: reading.ceilingCents ?? null,
    prerequisiteMet: reading.prerequisiteMet ?? null,
    ageFit: shown.age.rule
      ? ageFitFromRule(shown.age.rule, childFor(child), { now: input.now, timeZone })
      : 'unknown',
    taxBound: taxBoundFor(new URL(plan.registrationUrl).hostname),
    timeZone,
  });
  const opensNow = plan.alreadyOpen || plan.opensAt.getTime() <= input.now.getTime();
  if (bound.kind === 'terms_unsent') {
    return reply(database, input, deps, plan, 'offer', {
      terms: writerTerms(shown, { runsNow: opensNow }),
      boundBy,
    });
  }
  if (bound.kind === 'outside_band') {
    await markOffer(database, {
      offerId: plan.offerId,
      familyId: input.familyId,
      from: 'pending',
      status: 'handed_back',
      messageId,
      now: input.now,
    });
    return reply(database, input, deps, plan, 'refused', {
      refusal: 'age_outside_band',
      terms: writerTerms(shown),
      noLink: true,
      boundBy,
    });
  }
  if (bound.kind === 'clarify') {
    // A no to what the class needs answers the ask: asking it again would never end.
    if (bound.reason === 'prerequisite' && reading.prerequisiteMet === false) {
      await markOffer(database, {
        offerId: plan.offerId,
        familyId: input.familyId,
        from: 'pending',
        status: 'handed_back',
        messageId,
        now: input.now,
      });
      return reply(database, input, deps, plan, 'declined', { boundBy });
    }
    if (bound.reason === 'prerequisite') {
      return reply(database, input, deps, plan, 'clarify', {
        question: termsPrerequisiteQuestion(shown.prerequisite.quote),
        asksPrerequisite: true,
        boundBy,
      });
    }
    return reply(database, input, deps, plan, 'clarify', {
      question: TERMS_AMOUNT_QUESTION,
      boundBy,
    });
  }
  let seasonKey: string | null = null;
  if (bound.approved.countsAgainstSeason) {
    const slot = await claimSeasonSlot(database, input);
    if (!slot.ok) {
      return reply(database, input, deps, plan, 'refused', {
        refusal: 'season_cap',
        terms: writerTerms(shown),
        boundBy,
      });
    }
    seasonKey = slot.seasonKey;
  }
  const approved = { ...bound.approved, seasonKey };
  const alreadyOpen = opensNow;
  const stored = await approveSignupPlan(database, {
    offerId: plan.offerId,
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    messageId,
    choiceIds: reading.choiceIds,
    maxPriceCents: approved.maxCents,
    opensAt: alreadyOpen ? input.now : plan.opensAt,
    waiverAccepted: reading.waiverAccepted,
    alreadyOpen,
    terms: { approved },
    now: input.now,
  });
  if (!stored.ok) {
    if (seasonKey) {
      await releaseSignupHelpAttempt(database, {
        familyId: input.familyId,
        seasonKey,
        now: input.now,
      });
    }
    return reply(database, input, deps, plan, 'refused', { refusal: stored.reason, boundBy });
  }
  return reply(database, input, deps, plan, 'approved', {
    choiceIds: reading.choiceIds,
    maxPriceCents: boundPriceCents(approved),
    waiverAccepted: reading.waiverAccepted,
    terms: writerTerms(shown, { runsNow: alreadyOpen, hold: approved.hold }),
    boundBy,
  });
}

/**
 * VIL-715 · with pre-flight on, a pick among the site's options is a new ask, never an edit
 * of the old approval. The parked plan closes, the option becomes an offer holding only
 * what the site listed, and a new yes binds it. Hale never pre-flighted that option, so it
 * always stops at checkout for the parent. An option with no start cannot be a session.
 */
async function pickAsNewAsk(
  database: Database,
  input: SignupRunInput,
  deps: PlanTurnDeps,
  plan: ConversablePlan,
  choice: SiteChoice | undefined,
  boundBy: PlanBinding,
): Promise<SignupRunResult> {
  if (!choice?.starts_at) {
    return reply(database, input, deps, plan, 'refused', { refusal: 'choices', boundBy });
  }
  await markOffer(database, {
    offerId: plan.offerId,
    familyId: input.familyId,
    from: 'planned',
    status: 'handed_back',
    now: input.now,
  });
  // The site lists no end time. A session whose end is its start reads as "end not known":
  // the bound run is told so, and matches this one on its start (`planFacts`).
  const session: SignupSession = {
    id: SITE_OPTION_SESSION_ID,
    label: choice.label,
    startsAt: choice.starts_at,
    endsAt: choice.starts_at,
    full: false,
    priceCents: choice.price_cents,
  };
  const prior = await loadSignupTerms(database, {
    offerId: plan.offerId,
    familyId: input.familyId,
  });
  const shown: SignupTermsShown = {
    v: 1,
    read: 'unread',
    program: { courseIds: [], name: choice.label },
    residency: 'unknown',
    age: { fit: 'unknown', band: null, rule: null },
    prerequisite: { required: 'unknown', quote: null },
    refund: null,
    currency: prior.status === 'read' ? prior.row.shown.currency : null,
    countsAgainstSeason: false,
    priorChargeUnknown: await priorChargeUnknown(database, {
      familyId: input.familyId,
      childId: plan.childId,
      activityKey: plan.activityKey,
    }),
    sessions: [
      {
        sessionId: session.id,
        rates: choice.price_cents === null ? [] : [{ rate: 'flat', cents: choice.price_cents }],
        tax: 'unknown',
        source: 'site_option',
      },
    ],
  };
  const stored = await recordSignupOffer(database, {
    familyId: input.familyId,
    childId: plan.childId,
    parentUserId: input.parentUserId,
    activityKey: plan.activityKey,
    activityLabel: plan.activityLabel,
    registrationUrl: plan.registrationUrl,
    sessions: [session],
    approvedPriceCents: null,
    planOpensAt: input.now,
    planAlreadyOpen: true,
    terms: { shown },
    now: input.now,
  });
  if (!stored.ok) {
    return reply(database, input, deps, plan, 'refused', { refusal: 'not_stored', boundBy });
  }
  await writePlanAudit(database, {
    familyId: input.familyId,
    actor: input.parentUserId,
    offerId: plan.offerId,
    after: { step: 'plan_pick_new_ask', nextOffer: stored.id, host: plan.providerHost },
  });
  const next: ConversablePlan = {
    ...plan,
    offerId: stored.id,
    status: 'pending',
    sessions: [session],
    opensAt: input.now,
    alreadyOpen: true,
    plan: null,
    availability: null,
    lastAskedSeq: null,
    createdAt: input.now,
  };
  return reply(database, input, deps, next, 'offer', {
    terms: writerTerms(shown, { runsNow: true }),
    boundBy,
  });
}

/** The one session of an offer recorded from a site's option. */
const SITE_OPTION_SESSION_ID = 'site-option';

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
  const reader = deps.mismatchReader ?? createMismatchReader(() => resolveReplyClient(undefined));
  const reading = await reader.read({ text: input.body, askedStart, choices: parsed });
  if (!reading) return stopped('plan_unread', plan);
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
  if (!binds(place, named ? 'tokens' : null)) {
    return reply(database, input, deps, plan, 'clarify', {
      question: PICK_ASK_BACK_QUESTION,
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
  if (await askIsOnTerms(database, input.familyId, plan.offerId)) {
    if (reading.verdict === 'option') {
      const choice = parsed.find((item) => item.id === reading.choiceId);
      return pickAsNewAsk(database, input, deps, plan, choice, boundBy);
    }
    // Hale sends no email: the parent gets the site's options in a model-written reply.
    return reply(database, input, deps, plan, 'clarify', {
      question: `Hale cannot email the provider. The site currently offers: ${parsed
        .map((item) => item.label)
        .join('; ')}. Which of these do they want, or should Hale join the waitlist?`,
      boundBy,
    });
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

/** An ask made under pre-flight stays on its terms after the flag goes off. */
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

const OUTCOME: Record<Exclude<PlanReplyMoment, 'run_finished'>, string> = {
  /** VIL-715 · the terms go out as the ask, because they never reached the parent. */
  offer: 'plan_terms_sent',
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
  moment: Exclude<PlanReplyMoment, 'run_finished'>,
  extra: {
    question?: string;
    refusal?: string;
    choiceIds?: readonly string[];
    maxPriceCents?: number;
    waiverAccepted?: boolean;
    boundBy?: PlanBinding;
    /** VIL-715 · the terms this text states. Absent, the writer's request is what it was. */
    terms?: PlanReplyTerms;
    /** A refusal that sends the parent nowhere: the class does not fit this child. */
    noLink?: boolean;
    /** This text asks whether the child has what the class needs. */
    asksPrerequisite?: boolean;
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
    ...(extra.terms ? { terms: extra.terms } : {}),
  };
  const writer = deps.planWriter ?? createPlanReplyWriter(() => resolveReplyClient(undefined));
  const text = await writer.write(facts);
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
    if (await askIsOnTerms(database, input.familyId, plan.offerId)) {
      await pageOps(database, {
        site: 'registration_text_unwritten',
        facts: { moment: moment === 'offer' ? 'offer' : 'reply' },
        ref: plan.offerId,
      });
    }
    return {
      claimed: true,
      outcome,
      reply: null,
      deliverOnThread: false,
      unsent: 'reply_unwritten',
    };
  }
  const link =
    (moment === 'refused' && !extra.noLink) || moment === 'offer' ? plan.registrationUrl : null;
  const asked = {
    familyId: input.familyId,
    parentUserId: input.parentUserId,
    offerIds: [plan.offerId],
  };
  return {
    claimed: true,
    outcome,
    reply: planReplyBody(text, link),
    deliverOnThread: true,
    // Only the text that carries the terms records them as received.
    stamp:
      moment === 'offer'
        ? termsAskStamp(database, asked)
        : extra.asksPrerequisite
          ? prerequisiteAskStamp(database, asked)
          : askStamp(database, asked),
  };
}
