import { type Database, schema } from '@hale/db';
import { and, eq, ne } from 'drizzle-orm';
import { noteRegistrationRunFailed, noteTaskCompleted } from '~/lib/analytics/product-hooks';
import { readParentLanguage } from '~/lib/channel/parent-language';
import { pageOps } from '~/lib/monitoring/failure-page';
import {
  BrowserUseEngineThrew,
  PAYMENT_RUN_MAX_COST_USD,
  SIGNUP_RUN_MAX_COST_USD,
} from '../browser-use/engine';
import { browserUseSignupPaymentEnabled } from '../browser-use/flag';
import { type ReceiptResult, captureMaskedReceipt } from '../browser-use/receipt';
import {
  type BrowserUsePlanCheckpoint,
  type BrowserUsePlanInput,
  type BrowserUsePlanResult,
  CHECKOUT_REVIEW_RUN_MAX_COST_USD,
  type PlanCharged,
  type PlanEngineDetail,
  type PlanEngineOutcome,
  type PlanBinding,
  type PlanConfirmedFacts,
  PlanEngineThrew,
  type PlanPaymentInput,
  type PlanResumeToken,
} from '../browser-use/plan-engine';
import { browserUseProxyFor } from '../browser-use/proxy';
import { loadProviderSession, recordBrowserUseProfile } from '../browser-use/vault';
import { signupProviderHost, typedOutsideGrant } from '../consent';
import {
  planCityLoginOwnerEnabled,
  providerAccountCreateEnabled,
  providerCredentialsEnabled,
} from '../credentials/flag';
import { markCredentialsStale, readCredentialsForRun } from '../credentials/store';
import { loginLinkExpiresAt } from '../login-link/code';
import { mintFreshLoginLink } from '../login-link/store';
import { BROWSER_USE_REGISTRATION_RESERVE_USD, signupSpendingCap } from '../run';
import {
  loadSignupIdentity,
  markOffer,
  recordBrowserUseCost,
  reserveBrowserUseAllowance,
} from '../store';
import { releaseSignupHelpAttempt, signupHelpSlotReleaseEnabled } from '../signup-help-season';
import { termsTimeZone } from '../terms/ask';
import { registrationFreeCheckoutEnabled, registrationPreflightEnabled } from '../terms/flag';
import { type SignupTermsRow, loadSignupTerms, priorChargeUnknown } from '../terms/store';
import type { CartDifference } from '../terms/types';
import { registrationUrlAllowed } from '../url';
import { childFirstName, parentTimeZone } from './conversation';
import { registrationPlanAtOpenEnabled, registrationPlanRunEnabled } from './flag';
import { signupPlanPrepDepsFromEnv } from './notice';
import {
  type PlanNoticeKind,
  type PlanPrepDeps,
  firstChoiceLabel,
  sendSignupPlanNotice,
} from './prep';
import {
  type ClaimedPlan,
  claimDuePlan,
  claimResumablePlan,
  loadPlanConsent,
  parkUnlessOpsStopped,
  planFieldsToType,
  planLapse,
  planOpsStopped,
  planTakenBack,
  releaseUnstartedPlansBeforeOpen,
  savePlanResume,
  writePlanAudit,
} from './store';
import { planModeFor } from './towns';
import { planOpensAtLocal } from './writer';

/**
 * How long before the open a sweep may claim a plan while
 * REGISTRATION_PLAN_AT_OPEN_ENABLED is off. While that flag is exactly `true`,
 * {@link planJoinLeadMs} is 0 and a plan is claimed only once the open has arrived.
 */
export const PLAN_JOIN_LEAD_MS = 3 * 60_000;

/** Lead passed to {@link claimDuePlan}. Zero once the at-open flag is exactly `true`. */
export function planJoinLeadMs(env: Record<string, string | undefined> = process.env): number {
  return registrationPlanAtOpenEnabled(env) ? 0 : PLAN_JOIN_LEAD_MS;
}
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
  /** What the run charged, from the engine; `unknown` once a payment may exist and none was read. */
  charged: PlanCharged;
  confirmationNumber: string | null;
  liveViewUrl: string | null;
  holdExpiresAt: Date | null;
  /** VIL-715 · what differed from the approval, on a `cart_mismatch`. */
  cartDifferences?: CartDifference[];
  /** VIL-715 · the bound terms, so the notice can say them. Absent on an unbound plan. */
  terms?: Pick<SignupTermsRow, 'shown' | 'approved'>;
  /** VIL-715 · the masked confirmation, or why there is none. Absent when none was tried. */
  receipt?: ReceiptResult;
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
  | 'open_window_passed'
  /** Registration is still ahead. The plan was not started and the parent is not texted. */
  | 'before_open'
  /** VIL-715 · no approval Hale can read stands behind this plan. Nothing was charged. */
  | 'terms_unreadable';

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
  if (registrationPlanAtOpenEnabled()) {
    const released = await releaseUnstartedPlansBeforeOpen(database, { now: input.now });
    for (const row of released) {
      await writePlanAudit(database, {
        familyId: row.familyId,
        actor: row.parentUserId,
        offerId: row.id,
        after: {
          step: 'plan_before_open',
          opensAt: row.opensAt?.toISOString() ?? null,
        },
      });
    }
    if (released.length > 0) {
      console.info(
        { released: released.length },
        'signup plans: returned to planned before the open',
      );
    }
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
        leadMs: planJoinLeadMs(),
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

/**
 * What an ops-stopped run may end on without its parent hearing: no provider run yet, or a run
 * whose read answer stopped short of submitting, paying or joining a waitlist. A cart it
 * reached lapses with the browser this ending closes. The list names what is silenced, so a
 * detail added later is told.
 */
const LEFT_NOTHING_DETAILS: ReadonlySet<PlanRunDetail> = new Set<PlanRunDetail>([
  'authorization_lapsed',
  'url_refused',
  'missed_open',
  'parent_town',
  'choices_gone',
  'missing_detail',
  'consent_missing',
  'consent_wider',
  'no_provider_session',
  'spend_reserve_reached',
  'seed_unavailable',
  'seed_failed',
  'browser_unavailable',
  'no_saved_card',
  'security_code',
  'spending_cap',
  'price_change',
  'payment_off',
  'total_unread',
  'currency_unknown',
  'choice_unreadable',
  'no_live_view',
  'captcha',
  'verification_code',
  'login_wall',
  'password_rejected',
  'waiting_room',
  'timed_open',
  'waiver',
  'medical',
  'unexpected_field',
  'session_not_found',
  'page_error',
]);
const STOPPED_SHORT_OUTCOMES: ReadonlySet<PlanRunOutcome> = new Set<PlanRunOutcome>([
  'cancelled',
  'not_open',
  'sold_out',
  'options_mismatch',
  'needs_login',
  'needs_human',
  'ready_for_parent',
]);

function leftNothingAtProvider(ending: {
  outcome: PlanRunOutcome;
  detail: PlanRunDetail;
}): boolean {
  if (ending.detail === 'none') return STOPPED_SHORT_OUTCOMES.has(ending.outcome);
  return (
    LEFT_NOTHING_DETAILS.has(ending.detail) &&
    (ending.outcome === 'error' || STOPPED_SHORT_OUTCOMES.has(ending.outcome))
  );
}

/** A run exists remotely: the family holds a place in line, or a payment may be under way. */
function holdsRun(resume: PlanResumeToken | null): resume is PlanResumeToken {
  return resume !== null && (resume.phase === 'paying' || resume.runId !== null);
}

/** The other children's names, read for the cart's kid check. Never sent to Browser Use. */
async function siblingFirstNames(
  database: Database,
  plan: { familyId: string; childId: string },
): Promise<string[]> {
  const rows = await database
    .select({ name: schema.children.name })
    .from(schema.children)
    .where(and(eq(schema.children.familyId, plan.familyId), ne(schema.children.id, plan.childId)));
  return rows.map((row) => row.name);
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
  if (
    registrationPlanAtOpenEnabled() &&
    !plan.alreadyOpen &&
    now.getTime() < plan.opensAt.getTime() &&
    !held &&
    !(plan.takenBack && (await planOpsStopped(database, plan)))
  ) {
    const released = await releaseUnstartedPlansBeforeOpen(database, {
      now,
      offerId: plan.offerId,
    });
    await writePlanAudit(database, {
      familyId: plan.familyId,
      actor: plan.parentUserId,
      offerId: plan.offerId,
      after: {
        step: 'plan_before_open',
        released: released.length > 0,
        opensAt: plan.opensAt.toISOString(),
      },
    });
    console.info({ offerId: plan.offerId }, 'signup plans: open is still ahead');
    return {
      offerId: plan.offerId,
      outcome: 'not_open',
      detail: 'before_open',
      notice: 'withheld',
    };
  }
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
  // Once a paying checkpoint stands, a payment run may exist: an engine that throws after it
  // cannot say nothing was charged.
  let paymentMayExist = held?.phase === 'paying';
  // The checkout review is never meant to pay. A charge Hale cannot rule out while no payment
  // run may exist came from it: it placed the order, its answer was never read, or the engine
  // threw once it had started. A human looks at that one.
  const pageIfReviewMayHavePlaced = async (charged: PlanCharged, detail: PlanRunDetail) => {
    if (charged !== 'unknown' || paymentMayExist) return;
    const page = await pageOps(database, {
      site:
        detail === 'review_placed_order'
          ? 'registration_review_placed_order'
          : 'registration_review_unread',
      facts: {},
      ref: plan.offerId,
    });
    console.warn(
      { offerId: plan.offerId, detail, page },
      'signup plans: the checkout review may have placed the order',
    );
  };
  // VIL-715: set once the plan's terms row is read. A slot the yes took comes back when no
  // run reached the provider; the row is what the notice states the terms from.
  let bound: Pick<SignupTermsRow, 'shown' | 'approved'> | null = null;
  let receipt: ReceiptResult | null = null;
  const end = async (
    ending: Omit<PlanOutcomeNotice, 'offerId' | 'familyId' | 'parentUserId'> & {
      costUsd?: string | null;
      sessionCostUsd?: string | null;
      started?: boolean;
      /** The browser this ending leaves open for the parent. */
      openBrowser?: PlanResumeToken | null;
    },
  ): Promise<PlanRunSummary> => {
    // Ending before this sweep reached the engine: let go of the run an earlier one left going.
    const released = held && !engineRan ? await runner.release(held) : null;
    await markOffer(database, {
      offerId: plan.offerId,
      familyId: plan.familyId,
      from: 'submitting',
      status: ending.outcome === 'completed' ? 'completed' : 'handed_back',
      now,
    });
    // Read after the mark, which puts the plan out of a stop's reach: a stop that committed
    // first is seen here and none can land later. Only where no charge can exist: a payment
    // that ran is always reported.
    const opsStopped =
      ending.charged === 'nothing' && !paymentMayExist && (await planOpsStopped(database, plan));
    // A run let go here was cancelled before anyone read what it did.
    const letGoUnread = held !== null && !engineRan;
    const silenced = opsStopped && !letGoUnread && leftNothingAtProvider(ending);
    const result = silenced
      ? {
          ...ending,
          outcome: 'cancelled' as const,
          detail: 'authorization_lapsed' as const,
          liveViewUrl: null,
          holdExpiresAt: null,
          sessionCostUsd: ending.openBrowser
            ? await runner.release(ending.openBrowser)
            : ending.sessionCostUsd,
        }
      : opsStopped
        ? // It cannot prove nothing was left, so it never reads as "nothing charged" later.
          {
            ...ending,
            outcome: letGoUnread ? ('needs_human' as const) : ending.outcome,
            detail: letGoUnread ? ('unconfirmed' as const) : ending.detail,
            charged: 'unknown' as const,
          }
        : ending;
    if (opsStopped && !silenced) {
      await pageOps(database, {
        site: 'registration_stop_unverified',
        facts: {},
        ref: plan.offerId,
      });
    }
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
    const seasonKey = bound?.approved?.seasonKey ?? null;
    if (
      seasonKey !== null &&
      (!started || result.outcome === 'not_open') &&
      signupHelpSlotReleaseEnabled()
    ) {
      await releaseSignupHelpAttempt(database, { familyId: plan.familyId, seasonKey, now });
    }
    const { costUsd, sessionCostUsd, started: _started, openBrowser: _open, ...facts } = result;
    const noticeFacts: PlanOutcomeNotice = {
      ...facts,
      offerId: plan.offerId,
      familyId: plan.familyId,
      parentUserId: plan.parentUserId,
      ...(bound ? { terms: bound } : {}),
      ...(receipt ? { receipt } : {}),
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
    // After the parent's text, so paging never holds it. Named whatever the text did.
    if (receipt && !receipt.ok) {
      const page = await pageOps(database, {
        site: 'registration_receipt_unsent',
        facts: { reason: receipt.reason },
        ref: plan.offerId,
      });
      console.warn(
        { offerId: plan.offerId, reason: receipt.reason, page },
        'signup plans: no receipt image',
      );
    }
    await audit({
      step: 'plan_finished',
      outcome: result.outcome,
      detail: result.detail,
      choiceIndex: result.choiceIndex,
      cartTotalCents: result.cartTotalCents,
      amountChargedCents: result.amountChargedCents,
      charged: result.charged,
      confirmed: result.confirmationNumber !== null,
      holdExpiresAt: result.holdExpiresAt?.toISOString() ?? null,
      costUsd: costUsd ?? null,
      sessionCostUsd: sessionCostUsd ?? released,
      notice,
      host,
      ...(result.cartDifferences ? { cartDifferences: result.cartDifferences } : {}),
      ...(opsStopped ? { stoppedFrom: { outcome: ending.outcome, detail: ending.detail } } : {}),
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
      charged: 'nothing',
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
      const reviewStarted = err instanceof PlanEngineThrew && err.reviewStarted;
      const charged = paymentMayExist || reviewStarted ? 'unknown' : 'nothing';
      await pageIfReviewMayHavePlaced(charged, 'engine_threw');
      return end({
        outcome: 'error',
        detail: 'engine_threw',
        choiceIndex: null,
        cartTotalCents: null,
        amountChargedCents: null,
        charged,
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
      const parked = await parkAndTell(database, plan, result, now, host, deps);
      if (parked) return parked;
    }
    await pageIfReviewMayHavePlaced(result.charged, result.detail);
    const completed = result.outcome === 'completed' && result.confirmationNumber !== null;
    return end({
      outcome: result.outcome === 'completed' && !completed ? 'needs_human' : result.outcome,
      detail: result.outcome === 'completed' && !completed ? 'unconfirmed' : result.detail,
      choiceIndex: result.choiceIndex,
      cartTotalCents: result.cartTotalCents,
      amountChargedCents: result.amountChargedCents,
      charged: result.charged,
      confirmationNumber: result.confirmationNumber,
      liveViewUrl: result.liveViewUrl,
      holdExpiresAt: result.holdExpiresAt,
      ...(result.cartDifferences ? { cartDifferences: result.cartDifferences } : {}),
      costUsd: result.costUsd,
      sessionCostUsd: result.sessionCostUsd,
      started: result.sessionId !== null || result.runId !== null,
      openBrowser:
        result.liveViewUrl === null
          ? null
          : {
              phase: 'signup',
              runId: result.runId,
              sessionId: result.sessionId,
              browserId: result.browserId,
            },
    });
  };
  const onStep: BrowserUsePlanInput['onStep'] = (step) =>
    audit({ ...step, step: `plan_${step.step}`, host });

  // VIL-715. Read before anything may end the plan, so a payment a later sweep picks up
  // still gets its receipt. Whether the row lets the plan go on is decided below.
  const termsRead = await loadSignupTerms(database, {
    offerId: plan.offerId,
    familyId: plan.familyId,
  });
  const approved = termsRead.status === 'read' ? termsRead.row.approved : null;
  // Only a stored approval changes what this run does or says. Without one, flag off, the
  // plan and its notice are today's.
  if (termsRead.status === 'read' && approved) bound = termsRead.row;
  // The receipt follows the flag: an approval outliving the flag keeps its checks only.
  const onConfirmed =
    approved && registrationPreflightEnabled(plan.familyId)
      ? async (facts: PlanConfirmedFacts) => {
          const session =
            facts.choiceIndex === null ? undefined : approved.sessions[facts.choiceIndex];
          receipt = await captureMaskedReceipt(
            { getCdpUrl: facts.getCdpUrl },
            {
              browserId: facts.browserId,
              registrationUrl: plan.registrationUrl,
              waitUntil: facts.waitUntil,
              keep: {
                confirmationNumber: facts.confirmationNumber,
                className: session?.program.name ?? null,
                amount:
                  facts.amountChargedCents === null
                    ? null
                    : `$${(facts.amountChargedCents / 100).toFixed(2)}`,
              },
            },
          );
          await audit(
            receipt.ok
              ? {
                  step: 'plan_receipt',
                  ok: true,
                  sha256: receipt.receipt.sha256,
                  bytes: receipt.receipt.bytes,
                  kept: receipt.receipt.kept.length,
                  host,
                }
              : { step: 'plan_receipt', ok: false, reason: receipt.reason, host },
          );
        }
      : undefined;

  // The card may already be charged: read the payment before any check may end the plan.
  if (held?.phase === 'paying') {
    return carry(() =>
      runner.settlePayment({ resume: held, waitUntil: sweep.waitUntil, onStep, onConfirmed }),
    );
  }
  // An earlier sweep died during the checkout review. What the review did was never read and
  // it may have placed the order, so a charge may exist, whatever the plan's state now.
  if (held?.phase === 'signup' && held.reviewStarted) {
    await pageIfReviewMayHavePlaced('unknown', 'total_unread');
    return end({
      outcome: 'needs_human',
      detail: 'total_unread',
      choiceIndex: null,
      cartTotalCents: null,
      amountChargedCents: null,
      charged: 'unknown',
      confirmationNumber: null,
      liveViewUrl: null,
      holdExpiresAt: null,
    });
  }
  // VIL-715. A stored approval is enforced whatever the flag says now, so turning the flag
  // off in an incident cannot leave a bound plan payable on its maximum alone. A row code
  // cannot trust, or a plan with none while the flag is on, is handed back unpaid.
  if (
    termsRead.status === 'unreadable' ||
    (approved === null && registrationPreflightEnabled(plan.familyId))
  ) {
    const page = await pageOps(database, {
      site: 'registration_terms_unreadable',
      facts: {},
      ref: plan.offerId,
    });
    console.warn({ offerId: plan.offerId, page }, 'signup plans: no readable approval');
    return handBack('terms_unreadable');
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
  const storedAll = await loadProviderSession(database, {
    familyId: plan.familyId,
    providerHost,
    now,
  });
  const ownerGate = planCityLoginOwnerEnabled();
  const sessionForeign = Boolean(
    ownerGate && storedAll && storedAll.parentUserId !== plan.parentUserId,
  );
  const stored = sessionForeign ? null : storedAll;
  const credentialRead = providerCredentialsEnabled()
    ? await readCredentialsForRun(database, {
        familyId: plan.familyId,
        providerHost,
        parentUserId: plan.parentUserId,
        now,
      })
    : { status: 'absent' as const };
  const credentials = credentialRead.status === 'ready' ? credentialRead.credentials : null;
  const credentialsForeign = credentialRead.status === 'other_parent';
  if (sessionForeign || credentialsForeign) {
    const refused =
      sessionForeign && credentialsForeign ? 'both' : sessionForeign ? 'session' : 'credentials';
    await audit({
      step: 'plan_city_login_refused',
      reason: 'other_parent',
      refused,
      host: providerHost,
    });
    console.info(
      { offerId: plan.offerId, refused },
      'signup plans: city login belongs to the other parent',
    );
  }
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
  // A plan bound to a child with no name on file cannot pass the kid check: an empty name
  // never matches a cart's, so the run stops at the cart as `unread`/`kid`, unpaid.
  const binding: PlanBinding | null = approved
    ? {
        approved,
        childFirstName: identity.childFirstName ?? '',
        siblingFirstNames: await siblingFirstNames(database, plan),
        timeZone: termsTimeZone(host, await parentTimeZone(database, plan.parentUserId)),
        freeCheckoutEnabled: registrationFreeCheckoutEnabled(plan.familyId),
        priorChargeNow: () =>
          priorChargeUnknown(database, {
            familyId: plan.familyId,
            childId: plan.childId,
            activityKey: plan.activityKey,
          }),
      }
    : null;
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
      binding,
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
      onConfirmed,
      resume: held,
      waitUntil: sweep.waitUntil,
      onCheckpoint: async (resume) => {
        const saved = await savePlanResume(database, {
          offerId: plan.offerId,
          familyId: plan.familyId,
          resume,
          letGo: false,
        });
        if (saved && resume.phase === 'paying') paymentMayExist = true;
        return saved;
      },
    }),
  );
}

function askedStartFromAvailability(availability: Record<string, unknown> | null): string | null {
  if (!availability) return null;
  if (
    availability.kind === 'take_option' &&
    availability.choice &&
    typeof availability.choice === 'object'
  ) {
    const starts = (availability.choice as { starts_at?: unknown }).starts_at;
    if (typeof starts === 'string' && starts.trim()) return starts;
  }
  return typeof availability.askedStart === 'string' ? availability.askedStart : null;
}

/** Null when an ops stop is on the plan: nothing was parked and the parent was asked nothing. */
async function parkAndTell(
  database: Database,
  plan: ClaimedPlan,
  result: BrowserUsePlanResult,
  now: Date,
  host: string | null,
  deps: PlanRunDeps,
): Promise<PlanRunSummary | null> {
  const passwordRejected = result.detail === 'password_rejected';
  if (passwordRejected) {
    await markCredentialsStale(database, {
      familyId: plan.familyId,
      providerHost: host ?? new URL(plan.registrationUrl).hostname,
      now,
    });
  }
  // The card names the open only while it is still ahead for the card's whole life; the
  // run has usually reached the open by now, so the card is for finishing the session.
  const loginCard = passwordRejected
    ? {
        sessionLabel: firstChoiceLabel(plan.sessions, plan.choiceIds),
        opensAt:
          plan.opensAt.getTime() > loginLinkExpiresAt(now).getTime()
            ? planOpensAtLocal(plan.opensAt, await parentTimeZone(database, plan.parentUserId))
            : null,
      }
    : null;
  const parked = await parkUnlessOpsStopped(database, {
    offerId: plan.offerId,
    familyId: plan.familyId,
    availability: passwordRejected
      ? { kind: 'password_rejected' }
      : {
          kind: 'options_mismatch',
          choices: result.siteChoices ?? [],
          askedStart: plan.sessions[0]?.label ?? null,
        },
    now,
  });
  if (parked === 'ops_stopped') return null;
  if (result.sessionCostUsd) {
    await recordBrowserUseCost(database, {
      offerId: plan.offerId,
      familyId: plan.familyId,
      sessionCostUsd: result.sessionCostUsd,
      now,
    });
  }
  const kind: PlanNoticeKind = passwordRejected ? 'password_rejected' : 'options_mismatch';
  const facts = {
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
    askedStart: plan.sessions[0]?.label ?? null,
    loginCard,
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
      mintLink: loginCard
        ? (card) =>
            mintFreshLoginLink(database, {
              familyId: plan.familyId,
              parentUserId: plan.parentUserId,
              offerId: plan.offerId,
              providerHost: host ?? new URL(plan.registrationUrl).hostname,
              purpose: { kind: 'password_rejected', ...loginCard, card },
              now,
            })
        : undefined,
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
