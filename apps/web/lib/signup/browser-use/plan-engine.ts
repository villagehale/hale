import { presentUntrusted } from '@hale/agent';
import type { AuthorizedSignupPlanResume } from '@hale/db';
import { isEnabled } from '@hale/flags';
import { chargesNothing, compareCart } from '../terms/cart';
import type { CartDifference, CartRead, SignupTermsApproved } from '../terms/types';
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
  parentTakesOverLiveView,
  secretBindingsFor,
  settleBrowser,
  signupFacts,
  stopAndReadCost,
  sumCost,
  taskWithFacts,
  waitForRunUntil,
} from './engine';
import {
  BOUND_PLAN_OUTPUT_SCHEMA,
  BOUND_REVIEW_OUTPUT_SCHEMA,
  BROWSER_USE_PAYMENT_OUTPUT_SCHEMA,
  BROWSER_USE_PLAN_OUTPUT_SCHEMA,
  BROWSER_USE_REVIEW_OUTPUT_SCHEMA,
  type BrowserUseReviewOutput,
  parsePaymentOutput,
  parsePlanOutput,
  parseReviewOutput,
  sameProviderHttpsUrl,
} from './outcome';

/**
 * VIL-558 · carries out a parent's day-before plan at the open. One run joins the open
 * the way a punctual parent would (waiting room and queue included), takes the first
 * ranked choice still open, and stops at checkout. Hale's code then checks the cart
 * total against the plan's maximum and the spending cap (rule #7). A read-only review
 * in the same browser then chooses the saved card and stops on the last page before
 * "place order", and Hale's code checks the final total there, tax and fees included,
 * against the maximum and the cap again. Only then does a run pay that exact total, with
 * the card already saved on the parent's own city account. Hale never types a card on
 * this path. A missing saved card, a security code prompt, a final total it cannot read,
 * or a failed check leaves the cart on the live browser for the parent.
 */
export const PLAN_SIGNUP_SKILL = 'browser-use-plan-signup';
export const CHECKOUT_REVIEW_SKILL = 'browser-use-checkout-review';
export const SAVED_CARD_PAYMENT_SKILL = 'browser-use-saved-card-payment';
/** VIL-715 · the addendum a bound run carries: copy the cart's line off the page. */
export const CART_READ_SKILL = 'browser-use-cart-read';
/** VIL-715 · a $0 order: reach its last page and read it, without placing it. */
export const FREE_REVIEW_SKILL = 'browser-use-free-review';
/** VIL-715 · a $0 order: place it, only when the page asks for no payment. */
export const FREE_CHECKOUT_SKILL = 'browser-use-free-checkout';
/** The review chooses and reads; it never places the order. */
export const CHECKOUT_REVIEW_RUN_MAX_COST_USD = 1;
/**
 * The review's own window when checkout is reached at the sweep's end. The 10-minute sweep
 * budget plus this stays inside the route's 800 s.
 */
export const CHECKOUT_REVIEW_MIN_MS = 120_000;

export type PlanEngineOutcome =
  | BrowserUseEngineOutcome
  | 'not_open'
  | 'cancelled'
  /** Assisted mode: the registration is filled on the live browser for the parent to submit. */
  | 'ready_for_parent';

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
  | 'authorization_lapsed'
  /** Assisted mode: the agent said it added to the cart or submitted, which it must never do. */
  | 'submit_boundary'
  /** No final total was read before "place order", or it read below the cart total. */
  | 'total_unread'
  /** The env-only payment kill switch is not exactly `true`: nothing is paid. */
  | 'payment_off'
  /**
   * The checkout review said it placed the order, which it must never do: the card may be
   * charged, for an amount Hale never read. Never `payment_boundary`, which means nothing
   * was paid.
   */
  | 'review_placed_order'
  /** VIL-715 · the cart differs from what the parent approved. Nothing was charged. */
  | 'cart_mismatch'
  /** VIL-715 · the cart matched and the approval says stop here: the parent finishes. */
  | NonNullable<SignupTermsApproved['hold']>;

export type PlanEngineStep =
  | { step: 'checkout'; choiceIndex: number; cartTotalCents: number | null }
  | { step: 'ready'; choiceIndex: number; feeCents: number | null }
  | { step: 'spending_cap'; amountCents: number; ok: boolean }
  | { step: 'cart_check'; stage: 'cart' | 'final'; differences: CartDifference[]; ok: boolean }
  | {
      step: 'final_total';
      checkoutTotalCents: number;
      finalTotalCents: number | null;
      taxCents: number | null;
      feesCents: number | null;
      currency: string | null;
      /** `none` when the final total may be paid; otherwise why the cart went back. */
      detail: PlanEngineDetail;
      ok: boolean;
    }
  | {
      step: 'payment';
      outcome: PlanEngineOutcome;
      detail: PlanEngineDetail;
      amountChargedCents: number | null;
      confirmed: boolean;
    };

/**
 * VIL-715 · the parent's approval, for a run that must stop on any difference from it.
 * Null: a plan from before binding, which runs on its maximum alone.
 */
export interface PlanBinding {
  approved: SignupTermsApproved;
  /** The child the cart must name. Never sent to Browser Use from here. */
  childFirstName: string;
  /** The family's other children: a cart name that could be theirs is not this child's. */
  siblingFirstNames: readonly string[];
  /** The portal's zone, else the parent's, for reading the cart's date and time. */
  timeZone: string;
  /** The env-only switch for a $0 order, on for this family. Never arms a paid checkout. */
  freeCheckoutEnabled: boolean;
  /**
   * Whether an earlier run on this class for this child may have charged, read at the moment
   * of asking: one can end with an unknown charge after the yes, and the card must not pay twice.
   */
  priorChargeNow: () => Promise<boolean>;
}

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
    | 'credentials'
    | 'accountCreate'
    | 'joinWaitlist'
    | 'askedStart'
  > {
  /**
   * `auto`: Hale pays with the saved card at the open. `assisted`: Hale only fills, and the
   * parent submits and pays on the live browser (`runBrowserUseAssistedSignup`).
   */
  mode: 'auto' | 'assisted';
  /** The parent's ranked choices, best first. Never empty. */
  choices: BrowserUseSignupInput['session'][];
  maxPriceCents: number;
  /** The parent said Hale may tick the provider's activity waiver. */
  waiverAccepted: boolean;
  /**
   * The env-only payment kill switch (`browserUseSignupPaymentEnabled`). False stops the plan
   * at checkout, before the review and the saved card: the parent pays on the live browser.
   */
  paymentEnabled: boolean;
  /** VIL-715. Undefined or null: no approval is bound to this run. */
  binding?: PlanBinding | null;
  /** Rule #7, on the cart total and again on the final total, before the saved card is used. */
  checkSpendingCap: (amountCents: number) => Promise<{ ok: boolean; reason: string }>;
  /**
   * Rule #4, re-read before the review and again just before the saved card is used: false
   * stops the browser unpaid.
   */
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
  /**
   * VIL-715 · called once on a confirmed registration, before the browser stops, to capture
   * the masked receipt, with no browser id when the run never reported one. Absent: no
   * receipt. A failure here never changes the outcome.
   */
  onConfirmed?: (facts: PlanConfirmedFacts) => Promise<void>;
}

/** What reading a payment already under way needs: no identity, consent or saved session. */
export interface PlanPaymentInput
  extends Pick<BrowserUsePlanInput, 'onStep' | 'waitUntil' | 'onConfirmed'> {
  resume: PlanPayingToken;
}

/** VIL-715 · what the provider confirmed, while its confirmation page is still open. */
export interface PlanConfirmedFacts {
  browserId: string | null;
  confirmationNumber: string;
  amountChargedCents: number | null;
  choiceIndex: number | null;
  /** This sweep's end: the capture must be over by then. */
  waitUntil: Date;
  /** The browser's CDP address. A credential: never logged, never stored. */
  getCdpUrl: (browserId: string) => Promise<string | null>;
}

/**
 * What this run charged, as the engine knows it. `nothing`: the run stopped before any
 * payment run, or the card was declined. `unknown`: a payment run started, or the review
 * placed the order, and no charged amount was read; never read as zero. `cents`: the
 * amount the payment run read.
 */
export type PlanCharged = 'nothing' | 'unknown' | { cents: number };

export interface BrowserUsePlanResult extends Omit<BrowserUseSignupResult, 'outcome' | 'detail'> {
  outcome: PlanEngineOutcome;
  detail: PlanEngineDetail;
  /** Index into `choices` of the session in the cart, or null when none was. */
  choiceIndex: number | null;
  /** Set to `nothing` on every result, and only {@link reportPayment} may say otherwise. */
  charged: PlanCharged;
  /** VIL-715 · what differed from the approval, on a `cart_mismatch`. */
  cartDifferences?: CartDifference[];
}

interface PlanTracker extends BrowserTracker {
  /** Set before the checkout review run is created: from then on it may have placed the order. */
  reviewStarted: boolean;
}

/** The plan engine threw. `reviewStarted`: the checkout review may have placed the order. */
export class PlanEngineThrew extends BrowserUseEngineThrew {
  readonly reviewStarted: boolean;
  constructor(
    cause: unknown,
    ids: ConstructorParameters<typeof BrowserUseEngineThrew>[1] & { reviewStarted: boolean },
  ) {
    super(cause, ids);
    this.reviewStarted = ids.reviewStarted;
  }
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
  const marked = isEnabled('untrusted-field-marking');
  return {
    ...base,
    max_price_cents: input.maxPriceCents,
    waiver_accepted_by_parent: input.waiverAccepted,
    choices: input.choices.map((choice, rank) => ({
      rank: rank + 1,
      label:
        labels && choice.label.trim()
          ? presentUntrusted(marked, 'web', 'label', choice.label.trim())
          : undefined,
      starts_at: choice.startsAt,
      // On a bound run, a session whose end is its start has no known end. Unbound: as today.
      ends_at: input.binding && choice.endsAt === choice.startsAt ? null : choice.endsAt,
    })),
  };
}

/** A bound run's task carries the cart-read addendum. An unbound one is today's task. */
async function boundSkill(
  input: BrowserUsePlanInput,
  deps: BrowserUseEngineDeps,
  skill: string,
): Promise<string> {
  const task = await deps.loadTask(skill);
  return input.binding ? `${task}\n\n${await deps.loadTask(CART_READ_SKILL)}` : task;
}

const NOTHING_READ: CartRead = {
  provider_course_id: null,
  session_label: null,
  session_date: null,
  session_time: null,
  participant_first_name: null,
  line_count: null,
  quantity: null,
};

function cartForCompare(
  read: CartRead | null,
  totalCents: number | null,
  taxCents: number | null,
  feesCents: number | null,
  currency: string | null,
) {
  return { ...(read ?? NOTHING_READ), totalCents, taxCents, feesCents, currency };
}

function planResult(
  base: BrowserUseSignupResult,
  outcome: PlanEngineOutcome,
  detail: PlanEngineDetail,
  choiceIndex: number | null,
): BrowserUsePlanResult {
  return { ...base, outcome, detail, choiceIndex, charged: 'nothing' };
}

export function runBrowserUsePlanSignup(
  input: BrowserUsePlanInput,
  deps: BrowserUseEngineDeps,
): Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint> {
  return tracked(input, deps, (tracker) => drivePlan(input, deps, tracker));
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
  return tracked(input, deps, (tracker) => resumePayment(input, deps, tracker, input.resume));
}

async function tracked(
  input: Pick<BrowserUsePlanInput, 'onConfirmed' | 'waitUntil'> & {
    resume: PlanResumeToken | null;
  },
  deps: BrowserUseEngineDeps,
  drive: (tracker: PlanTracker) => Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint>,
): Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint> {
  const { resume } = input;
  const tracker: PlanTracker = {
    browserId: resume?.browserId ?? null,
    runId: resume?.runId ?? null,
    sessionId: resume?.sessionId ?? null,
    reviewStarted: false,
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
    throw new PlanEngineThrew(error, {
      runId: tracker.runId ?? null,
      sessionId,
      browserId: tracker.browserId,
      sessionCostUsd,
      reviewStarted: tracker.reviewStarted,
    });
  }
  // The browser holds the family's place in line until a later sweep picks it up.
  if (result.outcome === 'checkpointed') return result;
  if (input.onConfirmed && result.outcome === 'completed' && result.confirmationNumber) {
    await input
      .onConfirmed({
        browserId: tracker.browserId,
        confirmationNumber: result.confirmationNumber,
        amountChargedCents: result.amountChargedCents,
        choiceIndex: result.choiceIndex,
        waitUntil: input.waitUntil,
        getCdpUrl: async (id) => (await deps.api.getBrowser(id)).cdpUrl,
      })
      .catch((err: unknown) => {
        console.warn(
          { error: err instanceof Error ? err.name : 'unknown' },
          'signup plans: receipt capture threw',
        );
      });
  }
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
  tracker: PlanTracker,
): Promise<BrowserUsePlanResult | BrowserUsePlanCheckpoint> {
  if (input.resume?.phase === 'paying') return resumePayment(input, deps, tracker, input.resume);
  let runId: string | null = input.resume?.runId ?? null;
  try {
    if (!runId) {
      const profile = await ensureProfile(input, deps);
      if (!profile.ok)
        return planResult(failure('error', profile.detail), 'error', profile.detail, null);

      const run = await deps.api.createRun({
        task: taskWithFacts(await boundSkill(input, deps, PLAN_SIGNUP_SKILL), planFacts(input)),
        outputSchema: input.binding ? BOUND_PLAN_OUTPUT_SCHEMA : BROWSER_USE_PLAN_OUTPUT_SCHEMA,
        ...ACTION_MODEL,
        browserSettings: {
          profileId: profile.profileId,
          record: false,
          proxyCountryCode: input.proxyCountryCode ?? null,
        },
        keepAlive: CHECKOUT_KEEP_ALIVE_SECONDS,
        agentmail: false,
        maxCostUsd: SIGNUP_RUN_MAX_COST_USD,
        ...(secretBindingsFor(input) ? { secretBindings: secretBindingsFor(input) } : {}),
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
      return {
        ...stop(output.outcome, output.detail),
        liveViewUrl: parentTakesOverLiveView(output.outcome, output.detail) ? live : null,
        cartTotalCents: output.cart_total_cents,
        passwordRejectionMessage: output.password_rejection_message,
        passwordRule: output.password_rule,
        siteChoices: output.site_choices,
        seatsOpen: output.seats_open,
        fees: output.fees,
      };
    }
    const choiceIndex = output.choice_index;
    if (choiceIndex === null || choiceIndex >= input.choices.length) {
      return { ...stop('needs_human', 'choice_unreadable'), liveViewUrl: null };
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
    const bound = input.binding ? (input.binding.approved.sessions[choiceIndex] ?? null) : null;
    if (input.binding) {
      const differences = bound
        ? compareCart(
            bound,
            cartForCompare(output.cart_read, total, null, null, output.cart_currency),
            input.binding,
            'cart',
          )
        : (['unread'] as CartDifference[]);
      await input.onStep({
        step: 'cart_check',
        stage: 'cart',
        differences,
        ok: differences.length === 0,
      });
      if (differences.length > 0) {
        return { ...checkout, detail: 'cart_mismatch', cartDifferences: differences };
      }
      const hold =
        input.binding.approved.hold ??
        ((await input.binding.priorChargeNow()) ? ('prior_charge_unknown' as const) : null);
      if (hold) return { ...checkout, detail: hold };
    }
    if (total === null || (!input.binding && (total <= 0 || total > input.maxPriceCents))) {
      return { ...checkout, detail: 'price_change' };
    }
    const free = bound !== null && chargesNothing(bound.amount, total);
    if (!free && !output.saved_card_on_file) return { ...checkout, detail: 'no_saved_card' };
    if (!free && output.security_code_required) return { ...checkout, detail: 'security_code' };
    const cap = await input.checkSpendingCap(total);
    await input.onStep({ step: 'spending_cap', amountCents: total, ok: cap.ok });
    if (!cap.ok) return { ...checkout, detail: 'spending_cap' };
    if (!(await input.stillAuthorized())) {
      return stop('cancelled', 'authorization_lapsed', choiceIndex);
    }
    // A free order is armed by its own family-scoped switch, and never by the payment one.
    if (!(free ? input.binding?.freeCheckoutEnabled === true : input.paymentEnabled)) {
      return { ...checkout, detail: 'payment_off' };
    }
    if (!ids.sessionId) return checkout;

    await input.onCheckpoint({
      phase: 'signup',
      runId,
      sessionId: ids.sessionId,
      browserId: tracker.browserId,
      reviewStarted: true,
    });
    tracker.reviewStarted = true;
    const review = await reviewCheckout(input, deps, tracker, ids.sessionId, free);
    const reviewed: BrowserUsePlanResult = {
      ...checkout,
      liveViewUrl: review.liveViewUrl ?? live,
      costUsd: sumCost(checkout.costUsd, review.costUsd),
    };
    const final = finalTotal(review, {
      checkoutTotalCents: total,
      currency: output.cart_currency,
      maxPriceCents: input.maxPriceCents,
      free,
    });
    const read = review.kind === 'read' ? review.output : null;
    await input.onStep({
      step: 'final_total',
      checkoutTotalCents: total,
      finalTotalCents: read ? read.total_cents : null,
      taxCents: read ? read.tax_cents : null,
      feesCents: read ? read.fees_cents : null,
      currency: read ? read.currency : null,
      detail: final.ok ? 'none' : final.detail,
      ok: final.ok,
    });
    if (!final.ok) {
      // Only a review answer that was read can rule out a placed order. Placed, or never read,
      // a charge may exist: the browser stays on what the provider now shows, so it can be
      // checked, and the payment row records an amount not known.
      if (review.kind === 'unread' || final.detail === 'review_placed_order') {
        return reportPayment(input, { ...reviewed, detail: final.detail });
      }
      return {
        ...reviewed,
        detail: final.detail,
        cartTotalCents: final.detail === 'price_change' && read ? read.total_cents : total,
      };
    }
    if (input.binding && read) {
      const differences = bound
        ? compareCart(
            bound,
            cartForCompare(
              read.cart_read,
              read.total_cents,
              read.tax_cents,
              read.fees_cents,
              read.currency,
            ),
            input.binding,
            'final',
          )
        : (['unread'] as CartDifference[]);
      await input.onStep({
        step: 'cart_check',
        stage: 'final',
        differences,
        ok: differences.length === 0,
      });
      if (differences.length > 0) {
        return {
          ...reviewed,
          detail: 'cart_mismatch',
          cartDifferences: differences,
          cartTotalCents: read.total_cents,
        };
      }
    }
    const finalCap = await input.checkSpendingCap(final.totalCents);
    await input.onStep({ step: 'spending_cap', amountCents: final.totalCents, ok: finalCap.ok });
    if (!finalCap.ok) {
      return { ...reviewed, detail: 'spending_cap', cartTotalCents: final.totalCents };
    }
    if (!(await input.stillAuthorized())) {
      return {
        ...stop('cancelled', 'authorization_lapsed', choiceIndex),
        costUsd: reviewed.costUsd,
      };
    }
    if (input.binding && (await input.binding.priorChargeNow())) {
      return { ...reviewed, detail: 'prior_charge_unknown', cartTotalCents: final.totalCents };
    }
    const ready: BrowserUsePlanResult = { ...reviewed, cartTotalCents: final.totalCents };
    return await payWithSavedCard(input, deps, tracker, ready, {
      currency: output.cart_currency,
      free,
      paying: {
        phase: 'paying',
        runId: null,
        sessionId: ids.sessionId,
        browserId: tracker.browserId,
        choiceIndex,
        cartTotalCents: final.totalCents,
        holdExpiresAt: ready.holdExpiresAt?.toISOString() ?? null,
        costUsd: ready.costUsd,
      },
    });
  } catch (error) {
    if (runId) await deps.api.cancelRun(runId).catch(() => undefined);
    if (error instanceof BrowserUseApiError) {
      const failed = planResult(
        failure('error', 'api_error', { runId, sessionId: tracker.sessionId }),
        'error',
        'api_error',
        null,
      );
      // Once the review run exists it may have placed the order, as for a throw.
      return tracker.reviewStarted ? reportPayment(input, failed) : failed;
    }
    throw error;
  }
}

type CheckoutReview =
  | {
      kind: 'read';
      output: BrowserUseReviewOutput;
      costUsd: string | null;
      liveViewUrl: string | null;
    }
  | {
      kind: 'unread';
      detail: 'timeout' | 'run_failed' | 'unreadable_output' | 'api_error';
      costUsd: string | null;
      liveViewUrl: string | null;
    };

type FinalTotal = { ok: true; totalCents: number } | { ok: false; detail: PlanEngineDetail };

/**
 * One read-and-select run in the same browser: it chooses the saved card, ticks the waiver
 * only when the parent allowed it, and stops on the last page before "place order" without
 * pressing it. It is told no figure to expect. A run still going at its deadline is
 * cancelled; there is no resume phase for a review, so the cart goes back to the parent.
 */
async function reviewCheckout(
  input: BrowserUsePlanInput,
  deps: BrowserUseEngineDeps,
  tracker: BrowserTracker,
  sessionId: string,
  free: boolean,
): Promise<CheckoutReview> {
  let runId: string | null = null;
  try {
    const run = await deps.api.createRun({
      task: taskWithFacts(
        await boundSkill(input, deps, free ? FREE_REVIEW_SKILL : CHECKOUT_REVIEW_SKILL),
        {
          registration_url: input.registrationUrl,
          waiver_accepted_by_parent: input.waiverAccepted,
        },
      ),
      outputSchema: input.binding ? BOUND_REVIEW_OUTPUT_SCHEMA : BROWSER_USE_REVIEW_OUTPUT_SCHEMA,
      ...ACTION_MODEL,
      sessionId,
      keepAlive: CHECKOUT_KEEP_ALIVE_SECONDS,
      agentmail: false,
      maxCostUsd: CHECKOUT_REVIEW_RUN_MAX_COST_USD,
    });
    runId = run.id;
    const deadline = Math.max(
      input.waitUntil.getTime(),
      deps.now().getTime() + CHECKOUT_REVIEW_MIN_MS,
    );
    const waited = await waitForRunUntil(deps, run.id, deadline, tracker);
    if (waited.kind === 'timeout') {
      await deps.api.cancelRun(run.id).catch(() => undefined);
      return { kind: 'unread', detail: 'timeout', costUsd: null, liveViewUrl: waited.liveViewUrl };
    }
    const summary = await deps.api.getRun(run.id);
    const seen = { costUsd: summary.totalCostUsd, liveViewUrl: waited.liveViewUrl };
    if (waited.status !== 'completed') return { kind: 'unread', detail: 'run_failed', ...seen };
    const output = parseReviewOutput(summary.output);
    if (!output) return { kind: 'unread', detail: 'unreadable_output', ...seen };
    return { kind: 'read', output, ...seen };
  } catch (error) {
    if (runId) await deps.api.cancelRun(runId).catch(() => undefined);
    if (error instanceof BrowserUseApiError) {
      return { kind: 'unread', detail: 'api_error', costUsd: null, liveViewUrl: null };
    }
    throw error;
  }
}

/**
 * Code, not the review agent, decides whether the final total may be paid, and every doubt
 * hands the cart back. Tax and fees only add, so a final below the cart total is a subtotal.
 */
function finalTotal(
  review: CheckoutReview,
  at: {
    checkoutTotalCents: number;
    currency: string | null;
    maxPriceCents: number;
    /** A $0 order: no saved card and no currency, and the total must read exactly 0. */
    free: boolean;
  },
): FinalTotal {
  if (review.kind === 'unread') return { ok: false, detail: review.detail };
  const read = review.output;
  if (read.order_placed) return { ok: false, detail: 'review_placed_order' };
  if (read.outcome !== 'ready_to_place') {
    return { ok: false, detail: read.detail === 'none' ? 'total_unread' : read.detail };
  }
  if (!at.free && !read.saved_card_selected) return { ok: false, detail: 'no_saved_card' };
  const total = read.total_cents;
  if (total === null || total < at.checkoutTotalCents) return { ok: false, detail: 'total_unread' };
  if (at.free) {
    return total === 0 ? { ok: true, totalCents: 0 } : { ok: false, detail: 'price_change' };
  }
  // Two pages that both name no currency are not a match.
  if (read.currency === null || read.currency !== at.currency) {
    return { ok: false, detail: 'currency_unknown' };
  }
  if (total > at.maxPriceCents) return { ok: false, detail: 'price_change' };
  return { ok: true, totalCents: total };
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
  pay: { currency: string | null; free: boolean; paying: PlanPayingToken },
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
      task: pay.free
        ? taskWithFacts(await deps.loadTask(FREE_CHECKOUT_SKILL), {
            registration_url: input.registrationUrl,
            waiver_accepted_by_parent: input.waiverAccepted,
          })
        : taskWithFacts(await deps.loadTask(SAVED_CARD_PAYMENT_SKILL), {
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

/**
 * The one door for a result where a charge may exist: every payment run's end, a payment
 * whose run id was never stored, and a review that placed the order or was never read. It
 * writes the payment row and says what was charged.
 */
async function reportPayment(
  input: Pick<BrowserUsePlanInput, 'onStep'>,
  reported: BrowserUsePlanResult,
): Promise<BrowserUsePlanResult> {
  const charged: PlanCharged =
    reported.amountChargedCents !== null
      ? { cents: reported.amountChargedCents }
      : reported.detail === 'card_declined'
        ? 'nothing'
        : 'unknown';
  const result = { ...reported, charged };
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
    if (output.outcome === 'paid' && paying.cartTotalCents === 0) {
      // A free order: nothing was due, so a null amount is $0. Only the provider's own
      // confirmation number makes it `completed`.
      const charged = output.amount_charged_cents;
      if (charged !== null && charged > 0) {
        return handsOn('charge_mismatch', {
          liveViewUrl,
          costUsd,
          amountChargedCents: charged,
          confirmationNumber: output.confirmation_number,
        });
      }
      if (!output.confirmation_number) return handsOn('unconfirmed', { liveViewUrl, costUsd });
      return reportPayment(input, {
        ...checkout,
        outcome: 'completed',
        detail: 'none',
        liveViewUrl: null,
        checkoutUrl: null,
        holdExpiresAt: null,
        confirmationNumber: output.confirmation_number,
        amountChargedCents: 0,
        runId,
        costUsd,
      });
    }
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
