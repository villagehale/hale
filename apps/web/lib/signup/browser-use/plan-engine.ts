import type { AuthorizedSignupPlanResume } from '@hale/db';
import { BrowserUseApiError } from './client';
import {
  ACTION_MODEL,
  type BrowserTracker,
  type BrowserUseEngineDeps,
  type BrowserUseEngineDetail,
  type BrowserUseEngineOutcome,
  BrowserUseEngineThrew,
  type BrowserUseSignupInput,
  type BrowserUseSignupResult,
  CHECKOUT_KEEP_ALIVE_SECONDS,
  DEFAULT_CART_HOLD_MINUTES,
  PAYMENT_RUN_MAX_COST_USD,
  SIGNUP_RUN_MAX_COST_USD,
  ensureProfile,
  failure,
  settleBrowser,
  signupFacts,
  stopAndReadCost,
  sumCost,
  taskWithFacts,
  waitForRunUntil,
} from './engine';
import {
  BROWSER_USE_PAYMENT_OUTPUT_SCHEMA,
  BROWSER_USE_PLAN_OUTPUT_SCHEMA,
  parsePaymentOutput,
  parsePlanOutput,
  sameProviderHttpsUrl,
} from './outcome';

/**
 * VIL-558 · carries out a parent's day-before plan at the open. One run joins the open
 * the way a punctual parent would (waiting room and queue included), takes the first
 * ranked choice still open, and stops at checkout. Hale's code then checks the cart
 * total against the plan's maximum and the spending cap (rule #7). Only then does a
 * second run in the same browser pay, with the card already saved on the parent's
 * own city account. Hale never types a card on this path. A missing saved card, a
 * security code prompt, or a failed cap check leaves the cart on the live browser
 * for the parent.
 */
export const PLAN_SIGNUP_SKILL = 'browser-use-plan-signup';
export const SAVED_CARD_PAYMENT_SKILL = 'browser-use-saved-card-payment';

export type PlanEngineOutcome = BrowserUseEngineOutcome | 'not_open' | 'cancelled';

/**
 * Where a plan's run stands when a sweep ends before the run does. A town's queue can
 * outlast one sweep; the run is left going, so the family keeps its place in line, and a
 * later sweep picks it up from here.
 */
export type PlanResumeToken = AuthorizedSignupPlanResume;
export type PlanPayingToken = Extract<PlanResumeToken, { phase: 'paying' }>;

export interface BrowserUsePlanCheckpoint {
  outcome: 'checkpointed';
  resume: PlanResumeToken;
}

export type PlanEngineDetail =
  | BrowserUseEngineDetail
  | 'choice_unreadable'
  | 'no_saved_card'
  | 'security_code'
  | 'spending_cap'
  /** The parent's yes no longer stood at the moment of payment (rule #4). */
  | 'authorization_lapsed';

export type PlanEngineStep =
  | { step: 'checkout'; choiceIndex: number; cartTotalCents: number | null }
  | { step: 'spending_cap'; amountCents: number; ok: boolean }
  | {
      step: 'payment';
      outcome: PlanEngineOutcome;
      detail: PlanEngineDetail;
      amountChargedCents: number | null;
      confirmed: boolean;
    };

export interface BrowserUsePlanInput
  extends Pick<
    BrowserUseSignupInput,
    | 'correlationId'
    | 'registrationUrl'
    | 'identity'
    | 'fieldsAllowed'
    | 'providerSession'
    | 'onProfileCreated'
    | 'proxyCountryCode'
  > {
  /** The parent's ranked choices, best first. Never empty. */
  choices: BrowserUseSignupInput['session'][];
  maxPriceCents: number;
  /** The parent said Hale may tick the provider's activity waiver. */
  waiverAccepted: boolean;
  /** Rule #7, on the cart total, before the saved card is used. */
  checkSpendingCap: (amountCents: number) => Promise<{ ok: boolean; reason: string }>;
  /** Rule #4, re-read just before the saved card is used: false stops the browser unpaid. */
  stillAuthorized: () => Promise<boolean>;
  /** Called once per step so the caller writes one audit row each (rule #6). */
  onStep: (step: PlanEngineStep) => Promise<void>;
  /** Null on the first sweep; the stored token when a later sweep picks the run back up. */
  resume: PlanResumeToken | null;
  /** This sweep's end. A run still going then is checkpointed, never cancelled. */
  waitUntil: Date;
  /**
   * Stores where the run stands: as soon as a run exists, and before a payment run is
   * created, so a sweep the platform kills mid-run is resumed rather than run again.
   * False when the `paying` checkpoint was refused because the plan was taken back first:
   * nothing is paid.
   */
  onCheckpoint: (resume: PlanResumeToken) => Promise<boolean>;
}

/** What reading a payment already under way needs: no identity, consent or saved session. */
export interface PlanPaymentInput extends Pick<BrowserUsePlanInput, 'onStep' | 'waitUntil'> {
  resume: PlanPayingToken;
}

export interface BrowserUsePlanResult extends Omit<BrowserUseSignupResult, 'outcome' | 'detail'> {
  outcome: PlanEngineOutcome;
  detail: PlanEngineDetail;
  /** Index into `choices` of the session in the cart, or null when none was. */
  choiceIndex: number | null;
}

/** Only the slots on the consent grant. Every choice label is a `session` slot. */
export function planFacts(input: BrowserUsePlanInput): Record<string, unknown> {
  const first = input.choices[0];
  if (!first) throw new Error('a plan has at least one choice');
  const {
    session: _first,
    approved_price_cents: _price,
    ...base
  } = signupFacts({
    ...input,
    session: first,
    approvedPriceCents: input.maxPriceCents,
  });
  const labels = input.fieldsAllowed.includes('session');
  return {
    ...base,
    max_price_cents: input.maxPriceCents,
    waiver_accepted_by_parent: input.waiverAccepted,
    choices: input.choices.map((choice, rank) => ({
      rank: rank + 1,
      label: labels && choice.label.trim() ? choice.label.trim() : undefined,
      starts_at: choice.startsAt,
      ends_at: choice.endsAt,
    })),
  };
}

function planResult(
  base: BrowserUseSignupResult,
  outcome: PlanEngineOutcome,
  detail: PlanEngineDetail,
  choiceIndex: number | null,
): BrowserUsePlanResult {
  return { ...base, outcome, detail, choiceIndex };
}

export function runBrowserUsePlanSignup(
  input: BrowserUsePlanInput,
  deps: BrowserUseEngineDeps,
): Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint> {
  return tracked(input.resume, deps, (tracker) => drivePlan(input, deps, tracker));
}

/**
 * A later sweep reads a payment an earlier one started, before any of the plan's checks:
 * the card may already be charged, so its outcome is read and reported, never cancelled
 * unread. Without a stored run id it never pays again.
 */
export function settleBrowserUsePlanPayment(
  input: PlanPaymentInput,
  deps: BrowserUseEngineDeps,
): Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint> {
  return tracked(input.resume, deps, (tracker) =>
    resumePayment(input, deps, tracker, input.resume),
  );
}

async function tracked(
  resume: PlanResumeToken | null,
  deps: BrowserUseEngineDeps,
  drive: (tracker: BrowserTracker) => Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint>,
): Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint> {
  const tracker: BrowserTracker = {
    browserId: resume?.browserId ?? null,
    runId: resume?.runId ?? null,
    sessionId: resume?.sessionId ?? null,
  };
  let result: BrowserUsePlanResult | BrowserUsePlanCheckpoint;
  try {
    result = await drive(tracker);
  } catch (error) {
    const sessionId = tracker.sessionId ?? null;
    const sessionCostUsd = await stopAndReadCost(deps, {
      browserId: tracker.browserId,
      sessionId,
    }).catch(() => null);
    throw new BrowserUseEngineThrew(error, {
      runId: tracker.runId ?? null,
      sessionId,
      browserId: tracker.browserId,
      sessionCostUsd,
    });
  }
  // The browser holds the family's place in line until a later sweep picks it up.
  if (result.outcome === 'checkpointed') return result;
  return settleBrowser(deps, result, tracker);
}

/** Lets go of a checkpointed run: cancels it and stops its browser. Its cost so far, when read. */
export async function releasePlanRun(
  resume: PlanResumeToken,
  deps: BrowserUseEngineDeps,
): Promise<string | null> {
  if (resume.runId) await deps.api.cancelRun(resume.runId).catch(() => undefined);
  return stopAndReadCost(deps, { browserId: resume.browserId, sessionId: resume.sessionId });
}

async function drivePlan(
  input: BrowserUsePlanInput,
  deps: BrowserUseEngineDeps,
  tracker: BrowserTracker,
): Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint> {
  if (input.resume?.phase === 'paying') return resumePayment(input, deps, tracker, input.resume);
  let runId: string | null = input.resume?.runId ?? null;
  try {
    if (!runId) {
      const profile = await ensureProfile(input, deps);
      if (!profile.ok)
        return planResult(failure('error', profile.detail), 'error', profile.detail, null);

      const run = await deps.api.createRun({
        task: taskWithFacts(await deps.loadTask(PLAN_SIGNUP_SKILL), planFacts(input)),
        outputSchema: BROWSER_USE_PLAN_OUTPUT_SCHEMA,
        ...ACTION_MODEL,
        browserSettings: {
          profileId: profile.profileId,
          record: false,
          proxyCountryCode: input.proxyCountryCode ?? null,
        },
        keepAlive: CHECKOUT_KEEP_ALIVE_SECONDS,
        agentmail: false,
        maxCostUsd: SIGNUP_RUN_MAX_COST_USD,
      });
      runId = run.id;
      tracker.runId = run.id;
      tracker.sessionId = run.sessionId || null;
      await input.onCheckpoint({
        phase: 'signup',
        runId,
        sessionId: tracker.sessionId,
        browserId: null,
      });
    }

    const waited = await waitForRunUntil(deps, runId, input.waitUntil.getTime(), tracker);
    if (waited.kind === 'timeout') {
      return {
        outcome: 'checkpointed',
        resume: {
          phase: 'signup',
          runId,
          sessionId: tracker.sessionId ?? null,
          browserId: tracker.browserId,
        },
      };
    }
    const summary = await deps.api.getRun(runId);
    const ids = {
      runId,
      sessionId: summary.sessionId || tracker.sessionId || null,
      costUsd: summary.totalCostUsd,
    };
    if (ids.sessionId) tracker.sessionId = ids.sessionId;
    const stop = (
      outcome: PlanEngineOutcome,
      detail: PlanEngineDetail,
      choice: number | null = null,
    ) => planResult(failure('error', 'none', ids), outcome, detail, choice);
    if (waited.status === 'failed') return stop('error', 'run_failed');
    if (waited.status === 'cancelled') return stop('error', 'run_cancelled');

    const output = parsePlanOutput(summary.output);
    if (!output) return stop('error', 'unreadable_output');
    if (output.payment_details_entered) return stop('error', 'payment_boundary');
    const live = waited.liveViewUrl;

    if (output.outcome !== 'reached_checkout') {
      const handsOn = output.outcome === 'needs_human' || output.outcome === 'needs_login';
      return {
        ...stop(output.outcome, output.detail),
        liveViewUrl: handsOn ? live : null,
        cartTotalCents: output.cart_total_cents,
      };
    }
    const choiceIndex = output.choice_index;
    if (choiceIndex === null || choiceIndex >= input.choices.length) {
      return { ...stop('needs_human', 'choice_unreadable'), liveViewUrl: live };
    }
    const total = output.cart_total_cents;
    await input.onStep({ step: 'checkout', choiceIndex, cartTotalCents: total });
    if (!live) return stop('error', 'no_live_view', choiceIndex);
    const holdMinutes = Math.min(
      output.hold_minutes ?? DEFAULT_CART_HOLD_MINUTES,
      CHECKOUT_KEEP_ALIVE_SECONDS / 60,
    );
    const checkout: BrowserUsePlanResult = {
      ...stop('needs_human', 'none', choiceIndex),
      liveViewUrl: live,
      checkoutUrl: sameProviderHttpsUrl(output.checkout_url, input.registrationUrl),
      holdExpiresAt: new Date(deps.now().getTime() + holdMinutes * 60_000),
      cartTotalCents: total,
    };
    if (total === null || total <= 0 || total > input.maxPriceCents) {
      return { ...checkout, detail: 'price_change' };
    }
    if (!output.saved_card_on_file) return { ...checkout, detail: 'no_saved_card' };
    if (output.security_code_required) return { ...checkout, detail: 'security_code' };
    const cap = await input.checkSpendingCap(total);
    await input.onStep({ step: 'spending_cap', amountCents: total, ok: cap.ok });
    if (!cap.ok) return { ...checkout, detail: 'spending_cap' };
    if (!(await input.stillAuthorized())) {
      return stop('cancelled', 'authorization_lapsed', choiceIndex);
    }
    if (!ids.sessionId) return checkout;
    return await payWithSavedCard(input, deps, tracker, checkout, {
      currency: output.cart_currency,
      paying: {
        phase: 'paying',
        runId: null,
        sessionId: ids.sessionId,
        browserId: tracker.browserId,
        choiceIndex,
        cartTotalCents: total,
        holdExpiresAt: checkout.holdExpiresAt?.toISOString() ?? null,
        costUsd: checkout.costUsd,
      },
    });
  } catch (error) {
    if (runId) await deps.api.cancelRun(runId).catch(() => undefined);
    if (error instanceof BrowserUseApiError) {
      return planResult(
        failure('error', 'api_error', { runId, sessionId: tracker.sessionId }),
        'error',
        'api_error',
        null,
      );
    }
    throw error;
  }
}

/**
 * A follow-up run in the same browser places the order once with the card the
 * parent saved on their city account. No card value is sent: the run carries no
 * secret bindings, so it cannot type a card. The `paying` checkpoint is stored before
 * the run is created, so no later sweep ever creates a second one.
 */
async function payWithSavedCard(
  input: BrowserUsePlanInput,
  deps: BrowserUseEngineDeps,
  tracker: BrowserTracker,
  checkout: BrowserUsePlanResult,
  pay: { currency: string | null; paying: PlanPayingToken },
): Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint> {
  if (!(await input.onCheckpoint(pay.paying))) {
    return {
      ...checkout,
      outcome: 'cancelled',
      detail: 'authorization_lapsed',
      liveViewUrl: null,
      checkoutUrl: null,
      holdExpiresAt: null,
    };
  }
  let run: { id: string };
  try {
    run = await deps.api.createRun({
      task: taskWithFacts(await deps.loadTask(SAVED_CARD_PAYMENT_SKILL), {
        amount_cents: pay.paying.cartTotalCents,
        currency: pay.currency,
        registration_url: input.registrationUrl,
        waiver_accepted_by_parent: input.waiverAccepted,
      }),
      outputSchema: BROWSER_USE_PAYMENT_OUTPUT_SCHEMA,
      ...ACTION_MODEL,
      sessionId: pay.paying.sessionId,
      keepAlive: CHECKOUT_KEEP_ALIVE_SECONDS,
      agentmail: false,
      maxCostUsd: PAYMENT_RUN_MAX_COST_USD,
    });
  } catch (error) {
    if (error instanceof BrowserUseApiError) {
      return reportPayment(input, { ...checkout, outcome: 'needs_human', detail: 'api_error' });
    }
    throw error;
  }
  const paying = { ...pay.paying, runId: run.id };
  await input.onCheckpoint(paying);
  return awaitPayment(input, deps, tracker, checkout, paying);
}

/** A later sweep picks up a payment. Without a stored run id it never pays again. */
async function resumePayment(
  input: Pick<BrowserUsePlanInput, 'onStep' | 'waitUntil'>,
  deps: BrowserUseEngineDeps,
  tracker: BrowserTracker,
  paying: PlanPayingToken,
): Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint> {
  const checkout: BrowserUsePlanResult = {
    ...planResult(
      failure('needs_human', 'none', {
        runId: paying.runId,
        sessionId: paying.sessionId,
        costUsd: paying.costUsd,
      }),
      'needs_human',
      'none',
      paying.choiceIndex,
    ),
    cartTotalCents: paying.cartTotalCents,
    holdExpiresAt: paying.holdExpiresAt ? new Date(paying.holdExpiresAt) : null,
  };
  // A sweep died between storing `paying` and storing the run id: a payment run may exist.
  if (!paying.runId) return reportPayment(input, { ...checkout, detail: 'unconfirmed' });
  return awaitPayment(input, deps, tracker, checkout, { ...paying, runId: paying.runId });
}

async function reportPayment(
  input: Pick<BrowserUsePlanInput, 'onStep'>,
  result: BrowserUsePlanResult,
): Promise<BrowserUsePlanResult> {
  await input.onStep({
    step: 'payment',
    outcome: result.outcome,
    detail: result.detail,
    amountChargedCents: result.amountChargedCents,
    confirmed: result.confirmationNumber !== null,
  });
  return result;
}

async function awaitPayment(
  input: Pick<BrowserUsePlanInput, 'onStep' | 'waitUntil'>,
  deps: BrowserUseEngineDeps,
  tracker: BrowserTracker,
  checkout: BrowserUsePlanResult,
  paying: PlanPayingToken & { runId: string },
): Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint> {
  const runId = paying.runId;
  const handsOn = (
    detail: PlanEngineDetail,
    extra: Partial<BrowserUsePlanResult> = {},
  ): Promise<BrowserUsePlanResult> =>
    reportPayment(input, { ...checkout, outcome: 'needs_human', detail, runId, ...extra });
  try {
    const waited = await waitForRunUntil(deps, runId, input.waitUntil.getTime(), tracker);
    if (waited.kind === 'timeout') {
      return {
        outcome: 'checkpointed',
        resume: { ...paying, browserId: tracker.browserId ?? paying.browserId },
      };
    }
    const liveViewUrl = waited.liveViewUrl ?? checkout.liveViewUrl;
    const summary = await deps.api.getRun(runId);
    const costUsd = sumCost(checkout.costUsd, summary.totalCostUsd);
    if (waited.status !== 'completed') return handsOn('run_failed', { liveViewUrl, costUsd });
    const output = parsePaymentOutput(summary.output);
    if (!output) return handsOn('unreadable_output', { liveViewUrl, costUsd });
    if (output.outcome === 'paid') {
      const charged = output.amount_charged_cents;
      if (charged !== paying.cartTotalCents) {
        return handsOn(charged === null ? 'charge_unverified' : 'charge_mismatch', {
          liveViewUrl,
          costUsd,
          amountChargedCents: charged,
          confirmationNumber: output.confirmation_number,
        });
      }
      if (!output.confirmation_number) {
        return handsOn('unconfirmed', { liveViewUrl, costUsd, amountChargedCents: charged });
      }
      return reportPayment(input, {
        ...checkout,
        outcome: 'completed',
        detail: 'none',
        liveViewUrl: null,
        checkoutUrl: null,
        holdExpiresAt: null,
        confirmationNumber: output.confirmation_number,
        amountChargedCents: charged,
        runId,
        costUsd,
      });
    }
    if (output.outcome === 'declined') {
      return reportPayment(input, {
        ...checkout,
        outcome: 'payment_not_approved',
        detail: 'card_declined',
        liveViewUrl,
        runId,
        costUsd,
      });
    }
    return handsOn(output.detail === 'none' ? 'page_error' : output.detail, {
      liveViewUrl,
      costUsd,
    });
  } catch (error) {
    await deps.api.cancelRun(runId).catch(() => undefined);
    if (error instanceof BrowserUseApiError) return handsOn('api_error');
    throw error;
  }
}
