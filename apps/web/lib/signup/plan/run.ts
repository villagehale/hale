import type { Database } from '@hale/db';
import {
  BrowserUseEngineThrew,
  PAYMENT_RUN_MAX_COST_USD,
  SIGNUP_RUN_MAX_COST_USD,
} from '../browser-use/engine';
import type {
  BrowserUsePlanInput,
  BrowserUsePlanResult,
  PlanEngineDetail,
  PlanEngineOutcome,
} from '../browser-use/plan-engine';
import { browserUseProxyFor } from '../browser-use/proxy';
import { loadProviderSession, recordBrowserUseProfile } from '../browser-use/vault';
import { signupProviderHost, typedOutsideGrant } from '../consent';
import { BROWSER_USE_REGISTRATION_RESERVE_USD, signupSpendingCap } from '../run';
import {
  loadSignupIdentity,
  markOffer,
  recordBrowserUseCost,
  reserveBrowserUseAllowance,
} from '../store';
import { registrationUrlAllowed } from '../url';
import { registrationPlanRunEnabled } from './flag';
import {
  type ClaimedPlan,
  claimDuePlan,
  loadPlanConsent,
  planFieldsToType,
  planLapse,
  writePlanAudit,
} from './store';
import { planModeFor } from './towns';

/** Hale joins the open this long before it, the way a punctual parent would. */
export const PLAN_JOIN_LEAD_MS = 3 * 60_000;
/** Past this, the open is long gone: the plan goes back to the parent instead of running late. */
export const PLAN_MAX_LATE_MS = 6 * 60 * 60_000;
/** Plans one sweep starts at most. Each family still gets one session at a time. */
export const PLAN_SWEEP_MAX = 10;
/** The signup and saved-card payment agent caps, plus $1 for browser time and seeding. */
export const PLAN_RUN_ALLOWANCE_USD = SIGNUP_RUN_MAX_COST_USD + PAYMENT_RUN_MAX_COST_USD + 1;

export interface PlanSignupRunner {
  run(input: BrowserUsePlanInput): Promise<BrowserUsePlanResult>;
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
  | 'assisted_town'
  | 'url_refused'
  | 'missing_detail'
  | 'choices_gone'
  | 'consent_missing'
  | 'consent_wider'
  | 'no_provider_session'
  | 'spend_reserve_reached'
  | 'engine_threw';

/** Told nothing: a parent whose yes no longer stands (an opt-out, a departure) is not texted. */
export type PlanNotice = 'sent' | 'failed' | 'withheld';

export interface PlanRunDeps {
  /** The Browser Use plan engine. Null names it absent: no plan is claimed. */
  runner: PlanSignupRunner | null;
  /** Tells the parent what happened. Required: every plan ends with a notice or a named failure. */
  notifyParent: (notice: PlanOutcomeNotice) => Promise<'sent' | 'failed'>;
  /** Rule #7. Undefined uses `signupSpendingCap`: the plan's maximum, never above $500. */
  checkSpendingCap?: (
    familyId: string,
    cost: { amountUsd: number; category: string },
  ) => Promise<{ ok: boolean; reason: string }>;
  /** Undefined uses `PLAN_AUTO_HOSTS`. */
  autoHosts?: readonly string[];
}

export interface PlanRunSummary {
  offerId: string;
  outcome: PlanRunOutcome;
  detail: PlanRunDetail;
  notice: PlanNotice;
}

export type PlanSweepResult =
  | { skipped: 'flag_off' | 'not_configured'; plans: [] }
  | { skipped: null; plans: PlanRunSummary[] };

/**
 * VIL-558 · carries out every day-before plan whose open is now. Dark behind its own
 * kill switch. Each plan writes one audit row per step: started, checkout, spending
 * cap, payment, finished (rule #6). A plan whose yes no longer stands ({@link planLapse},
 * read at the claim and again before payment) ends `cancelled` and texts no one.
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
    const plan = await claimDuePlan(database, { now: input.now, leadMs: PLAN_JOIN_LEAD_MS });
    if (plan === 'contended') continue;
    if (!plan) break;
    claimed.push(plan);
  }
  const plans = await Promise.all(
    claimed.map((plan) => runOnePlan(database, plan, input.now, runner, deps)),
  );
  console.info(
    { claimed: plans.length, completed: plans.filter((p) => p.outcome === 'completed').length },
    'signup plans: sweep done',
  );
  return { skipped: null, plans };
}

async function runOnePlan(
  database: Database,
  plan: ClaimedPlan,
  now: Date,
  runner: PlanSignupRunner,
  deps: PlanRunDeps,
): Promise<PlanRunSummary> {
  const audit = (after: Record<string, unknown>) =>
    writePlanAudit(database, {
      familyId: plan.familyId,
      actor: plan.parentUserId,
      offerId: plan.offerId,
      after,
    });
  const allowed = registrationUrlAllowed(plan.registrationUrl);
  const host = allowed.ok ? new URL(allowed.href).hostname : null;
  const mode = host ? planModeFor(host, deps.autoHosts) : 'assisted';
  await audit({
    step: 'plan_started',
    choices: plan.choiceIds.length,
    opensAt: plan.opensAt.toISOString(),
    mode,
    host,
  });

  let allowanceHeld = false;
  const end = async (
    result: Omit<PlanOutcomeNotice, 'offerId' | 'familyId' | 'parentUserId'> & {
      costUsd?: string | null;
      sessionCostUsd?: string | null;
      started?: boolean;
    },
  ): Promise<PlanRunSummary> => {
    await markOffer(database, {
      offerId: plan.offerId,
      familyId: plan.familyId,
      from: 'submitting',
      status: result.outcome === 'completed' ? 'completed' : 'handed_back',
      now,
    });
    // An allowance whose run never started is released; a started one keeps its
    // hold until the session's real cost replaces it.
    const settled = result.sessionCostUsd ?? (allowanceHeld && !result.started ? '0' : null);
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
      sessionCostUsd: sessionCostUsd ?? null,
      notice,
      host,
    });
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

  const lapse = await planLapse(database, plan);
  if (lapse) {
    console.info({ offerId: plan.offerId, lapse }, 'signup plans: the yes no longer stands');
    return handBack('authorization_lapsed', 'cancelled');
  }
  if (!allowed.ok || !host) return handBack('url_refused');
  if (now.getTime() - plan.opensAt.getTime() > PLAN_MAX_LATE_MS) return handBack('missed_open');
  if (mode === 'assisted') return handBack('assisted_town');
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
  if (!stored) return handBack('no_provider_session', 'needs_login');
  const reserved = await reserveBrowserUseAllowance(database, {
    offerId: plan.offerId,
    familyId: plan.familyId,
    allowanceUsd: PLAN_RUN_ALLOWANCE_USD,
    reserveUsd: BROWSER_USE_REGISTRATION_RESERVE_USD,
    now,
  });
  if (!reserved.ok) return handBack('spend_reserve_reached', 'error');
  allowanceHeld = true;

  const cap = deps.checkSpendingCap ?? signupSpendingCap(plan.maxPriceCents);
  let result: BrowserUsePlanResult;
  try {
    result = await runner.run({
      correlationId: plan.offerId,
      registrationUrl: allowed.href,
      identity,
      fieldsAllowed: granted,
      choices,
      maxPriceCents: plan.maxPriceCents,
      waiverAccepted: plan.waiverAccepted,
      providerSession: {
        storageState: stored.storageState,
        browserUseProfileId: stored.browserUseProfileId,
      },
      onProfileCreated: (profileId) =>
        recordBrowserUseProfile(database, { sessionRowId: stored.id, profileId }),
      proxyCountryCode: browserUseProxyFor(providerHost),
      checkSpendingCap: (amountCents) =>
        cap(plan.familyId, { amountUsd: amountCents / 100, category: 'registration' }),
      stillAuthorized: async () => {
        const late = await planLapse(database, plan);
        if (late)
          console.info(
            { offerId: plan.offerId, lapse: late },
            'signup plans: yes lapsed before payment',
          );
        return late === null;
      },
      onStep: (step) => audit({ ...step, step: `plan_${step.step}`, host }),
    });
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
}
