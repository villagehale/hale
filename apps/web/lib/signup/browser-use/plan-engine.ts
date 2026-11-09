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
  waitForRun,
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

export async function runBrowserUsePlanSignup(
  input: BrowserUsePlanInput,
  deps: BrowserUseEngineDeps,
): Promise<BrowserUsePlanResult> {
  const tracker: BrowserTracker = { browserId: null, runId: null, sessionId: null };
  let result: BrowserUsePlanResult;
  try {
    result = await drivePlan(input, deps, tracker);
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
  return settleBrowser(deps, result, tracker);
}

async function drivePlan(
  input: BrowserUsePlanInput,
  deps: BrowserUseEngineDeps,
  tracker: BrowserTracker,
): Promise<BrowserUsePlanResult> {
  let runId: string | null = null;
  try {
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

    const waited = await waitForRun(deps, run.id, tracker);
    if (waited.kind === 'timeout') {
      return planResult(
        failure('error', 'timeout', { runId, sessionId: run.sessionId }),
        'error',
        'timeout',
        null,
      );
    }
    const summary = await deps.api.getRun(run.id);
    const ids = {
      runId,
      sessionId: summary.sessionId || run.sessionId,
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
    const paid = await payWithSavedCard(input, deps, tracker, checkout, {
      total,
      currency: output.cart_currency,
      sessionId: ids.sessionId,
    });
    await input.onStep({
      step: 'payment',
      outcome: paid.outcome,
      detail: paid.detail,
      amountChargedCents: paid.amountChargedCents,
      confirmed: paid.confirmationNumber !== null,
    });
    return paid;
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
 * secret bindings, so it cannot type a card.
 */
async function payWithSavedCard(
  input: BrowserUsePlanInput,
  deps: BrowserUseEngineDeps,
  tracker: BrowserTracker,
  checkout: BrowserUsePlanResult,
  pay: { total: number; currency: string | null; sessionId: string },
): Promise<BrowserUsePlanResult> {
  let runId: string | null = null;
  const handsOn = (
    detail: PlanEngineDetail,
    extra: Partial<BrowserUsePlanResult> = {},
  ): BrowserUsePlanResult => ({
    ...checkout,
    outcome: 'needs_human',
    detail,
    runId: runId ?? checkout.runId,
    ...extra,
  });
  try {
    const run = await deps.api.createRun({
      task: taskWithFacts(await deps.loadTask(SAVED_CARD_PAYMENT_SKILL), {
        amount_cents: pay.total,
        currency: pay.currency,
        registration_url: input.registrationUrl,
        waiver_accepted_by_parent: input.waiverAccepted,
      }),
      outputSchema: BROWSER_USE_PAYMENT_OUTPUT_SCHEMA,
      ...ACTION_MODEL,
      sessionId: pay.sessionId,
      keepAlive: CHECKOUT_KEEP_ALIVE_SECONDS,
      agentmail: false,
      maxCostUsd: PAYMENT_RUN_MAX_COST_USD,
    });
    runId = run.id;
    const waited = await waitForRun(deps, run.id, tracker);
    const liveViewUrl = waited.liveViewUrl ?? checkout.liveViewUrl;
    if (waited.kind === 'timeout') return handsOn('timeout', { liveViewUrl });
    const summary = await deps.api.getRun(run.id);
    const costUsd = sumCost(checkout.costUsd, summary.totalCostUsd);
    if (waited.status !== 'completed') return handsOn('run_failed', { liveViewUrl, costUsd });
    const output = parsePaymentOutput(summary.output);
    if (!output) return handsOn('unreadable_output', { liveViewUrl, costUsd });
    if (output.outcome === 'paid') {
      const charged = output.amount_charged_cents;
      if (charged !== pay.total) {
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
      return {
        ...checkout,
        outcome: 'completed',
        detail: 'none',
        liveViewUrl: null,
        checkoutUrl: null,
        holdExpiresAt: null,
        confirmationNumber: output.confirmation_number,
        amountChargedCents: charged,
        runId: run.id,
        costUsd,
      };
    }
    if (output.outcome === 'declined') {
      return {
        ...checkout,
        outcome: 'payment_not_approved',
        detail: 'card_declined',
        liveViewUrl,
        runId: run.id,
        costUsd,
      };
    }
    return handsOn(output.detail === 'none' ? 'page_error' : output.detail, {
      liveViewUrl,
      costUsd,
    });
  } catch (error) {
    if (runId) await deps.api.cancelRun(runId).catch(() => undefined);
    if (error instanceof BrowserUseApiError) return handsOn('api_error');
    throw error;
  }
}
