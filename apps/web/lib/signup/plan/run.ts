import type { Database } from '@hale/db';
import { noteRegistrationRunFailed, noteTaskCompleted } from '~/lib/analytics/product-hooks';
import { readParentLanguage } from '~/lib/channel/parent-language';
import { pageOps } from '~/lib/monitoring/failure-page';
import {
  BrowserUseEngineThrew,
  PAYMENT_RUN_MAX_COST_USD,
  SIGNUP_RUN_MAX_COST_USD,
} from '../browser-use/engine';
import { browserUseSignupPaymentEnabled } from '../browser-use/flag';
import {
  type BrowserUsePlanCheckpoint,
  type BrowserUsePlanInput,
  type BrowserUsePlanResult,
  CHECKOUT_REVIEW_RUN_MAX_COST_USD,
  type PlanEngineDetail,
  type PlanEngineOutcome,
  type PlanPaymentInput,
  type PlanResumeToken,
} from '../browser-use/plan-engine';
import { browserUseProxyFor } from '../browser-use/proxy';
import { loadProviderSession, recordBrowserUseProfile } from '../browser-use/vault';
import { signupProviderHost, typedOutsideGrant } from '../consent';
import { providerAccountCreateEnabled, providerCredentialsEnabled } from '../credentials/flag';
import { loadCredentialsForRun, markCredentialsStale } from '../credentials/store';
import { loginLinkExpiresAt } from '../login-link/code';
import { mintFreshLoginLink } from '../login-link/store';
import { BROWSER_USE_REGISTRATION_RESERVE_USD, signupSpendingCap } from '../run';
import {
  loadSignupIdentity,
  markOffer,
  recordBrowserUseCost,
  reserveBrowserUseAllowance,
} from '../store';
import { registrationUrlAllowed } from '../url';
import { childFirstName, parentTimeZone } from './conversation';
import { registrationMismatchPlanEnabled, registrationPlanRunEnabled } from './flag';
import { signupPlanPrepDepsFromEnv } from './notice';
import {
  type PlanNoticeKind,
  type PlanPrepDeps,
  type PlanPrepFacts,
  firstChoiceLabel,
  sendSignupPlanNotice,
} from './prep';
import { productionProviderEmailDrafter } from './provider-email';
import {
  type ClaimedPlan,
  claimDuePlan,
  claimResumablePlan,
  loadPlanConsent,
  parkSignupPlan,
  planFieldsToType,
  planLapse,
  planTakenBack,
  savePlanResume,
  writePlanAudit,
} from './store';
import { planModeFor } from './towns';
import { planOpensAtLocal } from './writer';

/** Hale joins the open this long before it, the way a punctual parent would. */
export const PLAN_JOIN_LEAD_MS = 3 * 60_000;
/**
 * The opening window. Past this, the open is long gone: a plan that has not started goes
 * back to the parent instead of running late, and a queue still waiting is let go.
 */
export const PLAN_MAX_LATE_MS = 6 * 60 * 60_000;
/**
 * How long one sweep waits on a run before it checkpoints it. The route may run 800 s;
 * the rest is for the claim before and the notice after.
 */
export const PLAN_SWEEP_BUDGET_MS = 10 * 60_000;
/** A sweep holds a claimed plan this long: longer than the route can run, so a killed sweep lets go. */
export const PLAN_LEASE_MS = 15 * 60_000;
/** Plans one sweep starts at most. Each family still gets one session at a time. */
export const PLAN_SWEEP_MAX = 10;
/**
 * The signup, checkout review and saved-card payment agent caps, plus $1 for browser time
 * and seeding.
 */
export const PLAN_RUN_ALLOWANCE_USD =
  SIGNUP_RUN_MAX_COST_USD + CHECKOUT_REVIEW_RUN_MAX_COST_USD + PAYMENT_RUN_MAX_COST_USD + 1;

export interface PlanSignupRunner {
  run(input: BrowserUsePlanInput): Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint>;
  /** Cancels a checkpointed run and stops its browser. The session's cost so far, when read. */
  release(resume: PlanResumeToken): Promise<string | null>;
  /** Reads what a payment an earlier sweep started did. Never cancels it, never pays again. */
  settlePayment(input: PlanPaymentInput): Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint>;
}

/** What the parent is told afterwards. `liveViewUrl` is credential-grade: parent only. */
export interface PlanOutcomeNotice {
  offerId: string;
  familyId: string;
  parentUserId: string;
  outcome: PlanRunOutcome;
  detail: PlanRunDetail;
  choiceIndex: number | null;
  cartTotalCents: number | null;
  amountChargedCents: number | null;
  confirmationNumber: string | null;
  liveViewUrl: string | null;
  holdExpiresAt: Date | null;
}

export type PlanRunOutcome = PlanEngineOutcome;
export type PlanRunDetail =
  | PlanEngineDetail
  | 'missed_open'
  /** A town with no plan mode: the parent registers. */
  | 'parent_town'
  | 'url_refused'
  | 'missing_detail'
  | 'choices_gone'
  | 'consent_missing'
  | 'consent_wider'
  | 'no_provider_session'
  | 'spend_reserve_reached'
  | 'engine_threw'
  /** A run was still waiting in the town's queue when the opening window closed. */
  | 'open_window_passed';

/** Told nothing: a parent whose yes no longer stands (an opt-out, a departure) is not texted. */
export type PlanNotice = 'sent' | 'failed' | 'withheld';

export interface PlanRunDeps {
  /** The Browser Use plan engine. Null names it absent: no plan is claimed. */
  runner: PlanSignupRunner | null;
  /**
   * Tells the parent what happened. Required: every plan ends with a notice or a named
   * failure. `withheld` when the parent's yes no longer stood by the time of the notice.
   */
  notifyParent: (notice: PlanOutcomeNotice) => Promise<PlanNotice>;
  /** Rule #7. Undefined uses `signupSpendingCap`: the plan's maximum, never above $500. */
  checkSpendingCap?: (
    familyId: string,
    cost: { amountUsd: number; category: string },
  ) => Promise<{ ok: boolean; reason: string }>;
  /** Undefined uses `PLAN_AUTO_HOSTS`. */
  autoHosts?: readonly string[];
  /** Event notices (rejected password, mismatched options). Undefined uses env wiring. */
  prep?: PlanPrepDeps;
}

export type PlanRunSummary =
  | { offerId: string; outcome: PlanRunOutcome; detail: PlanRunDetail; notice: PlanNotice }
  /** The run is still going (a queue, a payment); a later sweep picks it up. */
  | { offerId: string; outcome: 'checkpointed'; phase: PlanResumeToken['phase'] };

export type PlanSweepResult =
  | { skipped: 'flag_off' | 'not_configured'; plans: [] }
  | { skipped: null; plans: PlanRunSummary[] };

/**
 * VIL-558 · carries out every day-before plan whose open is now. Dark behind its own
 * kill switch. Each plan writes one audit row per step: started, checkout, spending
 * cap, final total, spending cap, payment, finished (rule #6). A plan whose yes no longer
 * stands ({@link planLapse}, read at the claim and again before payment) ends `cancelled`
 * and texts no one. The saved card is used only while the env-only payment switch
 * (`BROWSER_USE_SIGNUP_PAYMENT_ENABLED`) is exactly `true`; otherwise the plan stops at
 * checkout and the parent pays on the live browser.
 *
 * A run still going when the sweep's budget runs out is checkpointed, not cancelled: the
 * offer stays `submitting` with its resume token, the browser keeps the family's place in
 * line, and the next sweep picks it up before it claims any new plan. A payment already
 * under way is read before any check: the card may be charged, so it is recorded and
 * reported, never cancelled unread. A plan the parent took back while it ran is let go.
 * On an assisted town (ActiveNet) the engine only fills the registration and the parent gets the
 * live browser to submit and pay: no cap is asked because Hale moves no money there.
 */
export async function runDueSignupPlans(
  database: Database,
  input: { now: Date },
  deps: PlanRunDeps,
): Promise<PlanSweepResult> {
  if (!registrationPlanRunEnabled()) return { skipped: 'flag_off', plans: [] };
  const runner = deps.runner;
  if (!runner) {
    console.warn({ skipped: 'not_configured' }, 'signup plans: browser use engine not configured');
    return { skipped: 'not_configured', plans: [] };
  }
  const claimed: ClaimedPlan[] = [];
  for (
    let attempt = 0;
    attempt < 2 * PLAN_SWEEP_MAX && claimed.length < PLAN_SWEEP_MAX;
    attempt++
  ) {
    const plan =
      (await claimResumablePlan(database, { now: input.now, leaseMs: PLAN_LEASE_MS })) ??
      (await claimDuePlan(database, {
        now: input.now,
        leadMs: PLAN_JOIN_LEAD_MS,
        leaseMs: PLAN_LEASE_MS,
      }));
    if (plan === 'contended') continue;
    if (!plan) break;
    claimed.push(plan);
  }
  const waitUntil = new Date(input.now.getTime() + PLAN_SWEEP_BUDGET_MS);
  const plans = await Promise.all(
    claimed.map((plan) => runOnePlan(database, plan, { now: input.now, waitUntil }, runner, deps)),
  );
  console.info(
    {
      claimed: plans.length,
      resumed: claimed.filter((p) => p.resume !== null).length,
      checkpointed: plans.filter((p) => p.outcome === 'checkpointed').length,
      completed: plans.filter((p) => p.outcome === 'completed').length,
    },
    'signup plans: sweep done',
  );
  return { skipped: null, plans };
}

/** A run exists remotely: the family holds a place in line, or a payment may be under way. */
function holdsRun(resume: PlanResumeToken | null): resume is PlanResumeToken {
  return resume !== null && (resume.phase === 'paying' || resume.runId !== null);
}

async function runOnePlan(
  database: Database,
  plan: ClaimedPlan,
  sweep: { now: Date; waitUntil: Date },
  runner: PlanSignupRunner,
  deps: PlanRunDeps,
): Promise<PlanRunSummary> {
  const now = sweep.now;
  const held = holdsRun(plan.resume) ? plan.resume : null;
  const audit = (after: Record<string, unknown>) =>
    writePlanAudit(database, {
      familyId: plan.familyId,
      actor: plan.parentUserId,
      offerId: plan.offerId,
      after,
    });
  const allowed = registrationUrlAllowed(plan.registrationUrl);
  const host = allowed.ok ? new URL(allowed.href).hostname : null;
  const mode = host ? planModeFor(host, deps.autoHosts) : 'parent';
  await audit(
    plan.resume
      ? { step: 'plan_resumed', phase: plan.resume.phase, held: held !== null, host }
      : {
          step: 'plan_started',
          choices: plan.choiceIds.length,
          opensAt: plan.opensAt.toISOString(),
          mode,
          host,
        },
  );

  // A run an earlier sweep started already holds its allowance.
  let allowanceHeld = held !== null;
  let engineRan = false;
  const end = async (
    result: Omit<PlanOutcomeNotice, 'offerId' | 'familyId' | 'parentUserId'> & {
      costUsd?: string | null;
      sessionCostUsd?: string | null;
      started?: boolean;
    },
  ): Promise<PlanRunSummary> => {
    // Ending before this sweep reached the engine: let go of the run an earlier one left going.
    const released = held && !engineRan ? await runner.release(held) : null;
    await markOffer(database, {
      offerId: plan.offerId,
      familyId: plan.familyId,
      from: 'submitting',
      status: result.outcome === 'completed' ? 'completed' : 'handed_back',
      now,
    });
    // An allowance whose run never started is released; a started one keeps its
    // hold until the session's real cost replaces it.
    const started = result.started ?? held !== null;
    const settled = result.sessionCostUsd ?? released ?? (allowanceHeld && !started ? '0' : null);
    if (settled !== null) {
      await recordBrowserUseCost(database, {
        offerId: plan.offerId,
        familyId: plan.familyId,
        sessionCostUsd: settled,
        now,
      });
    }
    const { costUsd, sessionCostUsd, started: _started, ...facts } = result;
    const noticeFacts: PlanOutcomeNotice = {
      ...facts,
      offerId: plan.offerId,
      familyId: plan.familyId,
      parentUserId: plan.parentUserId,
    };
    const notice: PlanNotice =
      result.detail === 'authorization_lapsed'
        ? 'withheld'
        : await deps.notifyParent(noticeFacts).catch(() => 'failed' as const);
    if (notice === 'failed') {
      console.error(
        { offerId: plan.offerId, outcome: result.outcome, notice },
        'signup plans: parent notice failed',
      );
    }
    await audit({
      step: 'plan_finished',
      outcome: result.outcome,
      detail: result.detail,
      choiceIndex: result.choiceIndex,
      cartTotalCents: result.cartTotalCents,
      amountChargedCents: result.amountChargedCents,
      confirmed: result.confirmationNumber !== null,
      holdExpiresAt: result.holdExpiresAt?.toISOString() ?? null,
      costUsd: costUsd ?? null,
      sessionCostUsd: sessionCostUsd ?? released,
      notice,
      host,
    });
    if (result.outcome === 'error') {
      noteRegistrationRunFailed({
        familyId: plan.familyId,
        providerDomain: host,
        stage: result.detail,
        source: mode === 'assisted' ? 'assisted' : 'plan',
      });
    } else if (result.outcome === 'completed') {
      noteTaskCompleted({
        familyId: plan.familyId,
        type: 'registration',
        source: mode === 'assisted' ? 'assisted' : 'plan',
      });
    }
    return { offerId: plan.offerId, outcome: result.outcome, detail: result.detail, notice };
  };
  const handBack = (detail: PlanRunDetail, outcome: PlanRunOutcome = 'needs_human') =>
    end({
      outcome,
      detail,
      choiceIndex: null,
      cartTotalCents: null,
      amountChargedCents: null,
      confirmationNumber: null,
      liveViewUrl: null,
      holdExpiresAt: null,
    });

  const carry = async (
    go: () => Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint>,
  ): Promise<PlanRunSummary> => {
    let result: BrowserUsePlanResult | BrowserUsePlanCheckpoint;
    engineRan = true;
    try {
      result = await go();
    } catch (err) {
      console.warn(
        { offerId: plan.offerId, error: err instanceof Error ? err.name : 'unknown' },
        'signup plans: browser use engine threw',
      );
      const ids = err instanceof BrowserUseEngineThrew ? err : null;
      return end({
        outcome: 'error',
        detail: 'engine_threw',
        choiceIndex: null,
        cartTotalCents: null,
        amountChargedCents: null,
        confirmationNumber: null,
        liveViewUrl: null,
        holdExpiresAt: null,
        sessionCostUsd: ids?.sessionCostUsd ?? null,
        // A throw that names no session may still have started one: keep its hold.
        started: ids ? ids.sessionId !== null || ids.runId !== null : true,
      });
    }
    if (result.outcome === 'checkpointed') {
      await savePlanResume(database, {
        offerId: plan.offerId,
        familyId: plan.familyId,
        resume: result.resume,
        letGo: true,
      });
      await audit({ step: 'plan_checkpointed', phase: result.resume.phase, host });
      return { offerId: plan.offerId, outcome: 'checkpointed', phase: result.resume.phase };
    }
    if (result.outcome === 'options_mismatch' || result.detail === 'password_rejected') {
      return parkAndTell(database, plan, result, now, host, deps);
    }
    if (result.detail === 'review_placed_order') {
      const page = await pageOps(database, {
        site: 'registration_review_placed_order',
        facts: {},
        ref: plan.offerId,
      });
      console.warn(
        { offerId: plan.offerId, page },
        'signup plans: the checkout review says it placed the order',
      );
    }
    const completed = result.outcome === 'completed' && result.confirmationNumber !== null;
    return end({
      outcome: result.outcome === 'completed' && !completed ? 'needs_human' : result.outcome,
      detail: result.outcome === 'completed' && !completed ? 'unconfirmed' : result.detail,
      choiceIndex: result.choiceIndex,
      cartTotalCents: result.cartTotalCents,
      amountChargedCents: result.amountChargedCents,
      confirmationNumber: result.confirmationNumber,
      liveViewUrl: result.liveViewUrl,
      holdExpiresAt: result.holdExpiresAt,
      costUsd: result.costUsd,
      sessionCostUsd: result.sessionCostUsd,
      started: result.sessionId !== null || result.runId !== null,
    });
  };
  const onStep: BrowserUsePlanInput['onStep'] = (step) =>
    audit({ ...step, step: `plan_${step.step}`, host });

  // The card may already be charged: read the payment before any check may end the plan.
  if (held?.phase === 'paying') {
    return carry(() => runner.settlePayment({ resume: held, waitUntil: sweep.waitUntil, onStep }));
  }
  const lapse = plan.takenBack ? 'taken_back' : await planLapse(database, plan);
  if (lapse) {
    console.info({ offerId: plan.offerId, lapse }, 'signup plans: the yes no longer stands');
    return handBack('authorization_lapsed', 'cancelled');
  }
  if (!allowed.ok || !host) return handBack('url_refused');
  if (!plan.alreadyOpen && now.getTime() - plan.opensAt.getTime() > PLAN_MAX_LATE_MS) {
    return held ? handBack('open_window_passed', 'not_open') : handBack('missed_open');
  }
  if (mode === 'parent') return handBack('parent_town');
  const choices = plan.choiceIds.flatMap((id) => plan.sessions.filter((s) => s.id === id));
  if (choices.length !== plan.choiceIds.length) return handBack('choices_gone');
  const identity = await loadSignupIdentity(database, {
    familyId: plan.familyId,
    childId: plan.childId,
    parentUserId: plan.parentUserId,
    now,
  });
  if (!identity) return handBack('missing_detail');
  const providerHost = signupProviderHost(host);
  const granted = await loadPlanConsent(database, {
    familyId: plan.familyId,
    parentUserId: plan.parentUserId,
    messageId: plan.messageId,
    activityKey: plan.activityKey,
    providerHost,
  });
  if (!granted) return handBack('consent_missing');
  if (typedOutsideGrant(planFieldsToType(identity, choices), granted)) {
    return handBack('consent_wider');
  }
  const stored = await loadProviderSession(database, {
    familyId: plan.familyId,
    providerHost,
    now,
  });
  const credentials = providerCredentialsEnabled()
    ? await loadCredentialsForRun(database, {
        familyId: plan.familyId,
        providerHost,
        now,
      })
    : null;
  if (!stored && !credentials) return handBack('no_provider_session', 'needs_login');
  if (!held) {
    const reserved = await reserveBrowserUseAllowance(database, {
      offerId: plan.offerId,
      familyId: plan.familyId,
      allowanceUsd: PLAN_RUN_ALLOWANCE_USD,
      reserveUsd: BROWSER_USE_REGISTRATION_RESERVE_USD,
      now,
    });
    if (!reserved.ok) return handBack('spend_reserve_reached', 'error');
    allowanceHeld = true;
  }

  const cap = deps.checkSpendingCap ?? signupSpendingCap(plan.maxPriceCents);
  const pick = typeof plan.availability?.kind === 'string' ? plan.availability.kind : null;
  return carry(() =>
    runner.run({
      mode,
      correlationId: plan.offerId,
      registrationUrl: allowed.href,
      identity,
      fieldsAllowed: granted,
      choices,
      maxPriceCents: plan.maxPriceCents,
      waiverAccepted: plan.waiverAccepted,
      paymentEnabled: browserUseSignupPaymentEnabled(),
      credentials,
      accountCreate: providerAccountCreateEnabled(),
      joinWaitlist: pick === 'join_waitlist',
      askedStart: askedStartFromAvailability(plan.availability),
      providerSession: stored
        ? {
            storageState: stored.storageState,
            browserUseProfileId: stored.browserUseProfileId,
          }
        : { storageState: { cookies: [], origins: [] }, browserUseProfileId: null },
      onProfileCreated: (profileId) =>
        stored
          ? recordBrowserUseProfile(database, { sessionRowId: stored.id, profileId })
          : Promise.resolve(),
      proxyCountryCode: browserUseProxyFor(providerHost),
      checkSpendingCap: (amountCents) =>
        cap(plan.familyId, { amountUsd: amountCents / 100, category: 'registration' }),
      stillAuthorized: async () => {
        const late = (await planTakenBack(database, plan))
          ? 'taken_back'
          : await planLapse(database, plan);
        if (late)
          console.info(
            { offerId: plan.offerId, lapse: late },
            'signup plans: yes lapsed before payment',
          );
        return late === null;
      },
      onStep,
      resume: held,
      waitUntil: sweep.waitUntil,
      onCheckpoint: (resume) =>
        savePlanResume(database, {
          offerId: plan.offerId,
          familyId: plan.familyId,
          resume,
          letGo: false,
        }),
    }),
  );
}

function askedStartFromAvailability(availability: Record<string, unknown> | null): string | null {
  if (!availability) return null;
  // The provider fixed it: the run looks for the plan's own choices again.
  if (availability.kind === 'retry') return null;
  if (
    (availability.kind === 'take_option' || availability.kind === 'join_waitlist') &&
    availability.choice &&
    typeof availability.choice === 'object'
  ) {
    const starts = (availability.choice as { starts_at?: unknown }).starts_at;
    if (typeof starts === 'string' && starts.trim()) return starts;
  }
  return typeof availability.askedStart === 'string' ? availability.askedStart : null;
}

/** Whether the mismatch notice may offer the provider email: only one Hale can draft. */
async function emailDraftFor(
  database: Database,
  plan: ClaimedPlan,
  choices: NonNullable<BrowserUsePlanResult['siteChoices']>,
): Promise<NonNullable<PlanPrepFacts['emailDraft']>> {
  const ready = await productionProviderEmailDrafter(database).readiness({
    familyId: plan.familyId,
    actorUserId: plan.parentUserId,
    to: choices.map((choice) => choice.provider_email).find((email) => Boolean(email)) ?? null,
  });
  return ready.ok ? 'ready' : ready.reason;
}

async function parkAndTell(
  database: Database,
  plan: ClaimedPlan,
  result: BrowserUsePlanResult,
  now: Date,
  host: string | null,
  deps: PlanRunDeps,
): Promise<PlanRunSummary> {
  const passwordRejected = result.detail === 'password_rejected';
  const lit = registrationMismatchPlanEnabled(plan.familyId);
  // Lit, what the parent asked for is their first choice, as they ranked it.
  const askedStart = lit
    ? firstChoiceLabel(plan.sessions, plan.choiceIds)
    : (plan.sessions[0]?.label ?? null);
  if (passwordRejected) {
    await markCredentialsStale(database, {
      familyId: plan.familyId,
      providerHost: host ?? new URL(plan.registrationUrl).hostname,
      now,
    });
  }
  // The card names the open only while it is still ahead for the card's whole life; the
  // run has usually reached the open by now, so the card is for finishing the session.
  const minted = passwordRejected
    ? await mintFreshLoginLink(database, {
        familyId: plan.familyId,
        parentUserId: plan.parentUserId,
        offerId: plan.offerId,
        providerHost: host ?? new URL(plan.registrationUrl).hostname,
        purpose: {
          kind: 'password_rejected',
          sessionLabel: firstChoiceLabel(plan.sessions, plan.choiceIds),
          opensAt:
            plan.opensAt.getTime() > loginLinkExpiresAt(now).getTime()
              ? planOpensAtLocal(plan.opensAt, await parentTimeZone(database, plan.parentUserId))
              : null,
        },
        now,
      })
    : null;
  await parkSignupPlan(database, {
    offerId: plan.offerId,
    familyId: plan.familyId,
    availability: passwordRejected
      ? { kind: 'password_rejected' }
      : {
          kind: 'options_mismatch',
          choices: result.siteChoices ?? [],
          askedStart,
        },
    now,
  });
  if (result.sessionCostUsd) {
    await recordBrowserUseCost(database, {
      offerId: plan.offerId,
      familyId: plan.familyId,
      sessionCostUsd: result.sessionCostUsd,
      now,
    });
  }
  const kind: PlanNoticeKind = passwordRejected ? 'password_rejected' : 'options_mismatch';
  const facts: PlanPrepFacts = {
    kind,
    childFirstName: await childFirstName(database, {
      familyId: plan.familyId,
      childId: plan.childId,
    }),
    opensAt: planOpensAtLocal(plan.opensAt, await parentTimeZone(database, plan.parentUserId)),
    host: host ?? new URL(plan.registrationUrl).hostname,
    language: await readParentLanguage(database, {
      familyId: plan.familyId,
      parentUserId: plan.parentUserId,
    }),
    passwordRejectionMessage: result.passwordRejectionMessage ?? null,
    passwordRule: result.passwordRule ?? null,
    siteChoices: result.siteChoices ?? [],
    askedStart,
    ...(lit && !passwordRejected
      ? { emailDraft: await emailDraftFor(database, plan, result.siteChoices ?? []) }
      : {}),
  };
  const sent = await sendSignupPlanNotice(
    database,
    {
      familyId: plan.familyId,
      parentUserId: plan.parentUserId,
      offerId: plan.offerId,
      providerHost: host ?? new URL(plan.registrationUrl).hostname,
      kind,
      facts,
      link: minted?.url ?? null,
      linkAfter: 0,
      now,
    },
    deps.prep ?? signupPlanPrepDepsFromEnv(database),
  );
  await writePlanAudit(database, {
    familyId: plan.familyId,
    actor: plan.parentUserId,
    offerId: plan.offerId,
    after: { step: 'plan_parked', kind, host },
  });
  return {
    offerId: plan.offerId,
    outcome: result.outcome,
    detail: result.detail,
    notice: sent ? 'sent' : 'failed',
  };
}
