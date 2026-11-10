import { z } from 'zod';
import { BrowserUseApiError } from './client';
import {
  ACTION_MODEL,
  type BrowserTracker,
  type BrowserUseEngineDeps,
  BrowserUseEngineThrew,
  CHECKOUT_KEEP_ALIVE_SECONDS,
  SIGNUP_RUN_MAX_COST_USD,
  ensureProfile,
  failure,
  settleBrowser,
  stopAndReadCost,
  taskWithFacts,
  waitForRun,
} from './engine';
import { BROWSER_USE_SIGNUP_DETAILS, sameProviderHttpsUrl } from './outcome';
import {
  type BrowserUsePlanInput,
  type BrowserUsePlanResult,
  type PlanEngineDetail,
  type PlanEngineOutcome,
  planFacts,
  runBrowserUsePlanSignup,
} from './plan-engine';

/**
 * VIL-558 step 6 · assisted mode (ActiveNet). At the open one run joins the way a punctual
 * parent would, waiting room and queue included, fills the registration for the first
 * ranked choice still open with the details the parent allowed, and stops before the step
 * that adds it to the cart or submits it. The parent gets that live browser: they check
 * it, tick any waiver, submit and pay themselves.
 *
 * Hale never signs in, submits or pays here, so this engine creates exactly one run and
 * never asks the spending cap: no money moves on Hale's side. Any challenge stops the run.
 * An answer saying the agent went past the submit step, or touched a payment field, stops
 * the browser and hands nothing over.
 */
export const ASSISTED_SIGNUP_SKILL = 'browser-use-assisted-signup';

export const BROWSER_USE_ASSISTED_OUTCOMES = [
  'ready_for_parent',
  'not_open',
  'waitlist',
  'sold_out',
  'needs_login',
  'needs_human',
  'error',
] as const;

const assistedOutput = z.object({
  outcome: z.enum(BROWSER_USE_ASSISTED_OUTCOMES),
  detail: z.enum(BROWSER_USE_SIGNUP_DETAILS),
  choice_index: z.number().int().nonnegative().nullable(),
  page_url: z.string().nullable(),
  fee_cents: z.number().int().nonnegative().nullable(),
  submitted: z.boolean(),
  payment_details_entered: z.boolean(),
});

export const BROWSER_USE_ASSISTED_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: [
    'outcome',
    'detail',
    'choice_index',
    'page_url',
    'fee_cents',
    'submitted',
    'payment_details_entered',
  ],
  properties: {
    outcome: { type: 'string', enum: [...BROWSER_USE_ASSISTED_OUTCOMES] },
    detail: { type: 'string', enum: [...BROWSER_USE_SIGNUP_DETAILS] },
    choice_index: { type: ['integer', 'null'], minimum: 0 },
    page_url: { type: ['string', 'null'] },
    fee_cents: { type: ['integer', 'null'], minimum: 0 },
    submitted: { type: 'boolean' },
    payment_details_entered: { type: 'boolean' },
  },
};

/** Outcomes where the browser sits on the provider's site with a step the parent can take. */
const HANDS_ON: ReadonlySet<string> = new Set(['needs_human', 'needs_login', 'not_open']);

/** The plan's facts without the waiver answer: on this path the parent ticks it on the page. */
export function assistedFacts(input: BrowserUsePlanInput): Record<string, unknown> {
  const { waiver_accepted_by_parent: _waiver, ...facts } = planFacts(input);
  return facts;
}

/** The one place a plan's mode picks its engine: an assisted plan can never reach a payment run. */
export function runBrowserUsePlanForMode(
  input: BrowserUsePlanInput,
  deps: BrowserUseEngineDeps,
): Promise<BrowserUsePlanResult> {
  return input.mode === 'assisted'
    ? runBrowserUseAssistedSignup(input, deps)
    : runBrowserUsePlanSignup(input, deps);
}

export async function runBrowserUseAssistedSignup(
  input: BrowserUsePlanInput,
  deps: BrowserUseEngineDeps,
): Promise<BrowserUsePlanResult> {
  const tracker: BrowserTracker = { browserId: null, runId: null, sessionId: null };
  let result: BrowserUsePlanResult;
  try {
    result = await driveAssisted(input, deps, tracker);
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

async function driveAssisted(
  input: BrowserUsePlanInput,
  deps: BrowserUseEngineDeps,
  tracker: BrowserTracker,
): Promise<BrowserUsePlanResult> {
  const end = (
    outcome: PlanEngineOutcome,
    detail: PlanEngineDetail,
    extra: Partial<BrowserUsePlanResult> = {},
  ): BrowserUsePlanResult => ({
    ...failure('error', 'none', {
      runId: tracker.runId ?? null,
      sessionId: tracker.sessionId ?? null,
    }),
    outcome,
    detail,
    choiceIndex: null,
    ...extra,
  });
  let runId: string | null = null;
  try {
    const profile = await ensureProfile(input, deps);
    if (!profile.ok) return end('error', profile.detail);

    const run = await deps.api.createRun({
      task: taskWithFacts(await deps.loadTask(ASSISTED_SIGNUP_SKILL), assistedFacts(input)),
      outputSchema: BROWSER_USE_ASSISTED_OUTPUT_SCHEMA,
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
    // The run is cancelled at its deadline, but the browser stays: it may still hold the
    // family's place in line, and the parent is the one who submits anyway.
    if (waited.kind === 'timeout') {
      return end('needs_human', 'timeout', {
        liveViewUrl: waited.liveViewUrl,
        holdExpiresAt: waited.liveViewUrl ? browserHold(deps) : null,
      });
    }
    const summary = await deps.api.getRun(run.id);
    if (summary.sessionId) tracker.sessionId = summary.sessionId;
    const ids = { costUsd: summary.totalCostUsd };
    if (waited.status === 'failed') return end('error', 'run_failed', ids);
    if (waited.status === 'cancelled') return end('error', 'run_cancelled', ids);

    const parsed = assistedOutput.safeParse(summary.output);
    if (!parsed.success) return end('error', 'unreadable_output', ids);
    const output = parsed.data;
    if (output.payment_details_entered) return end('error', 'payment_boundary', ids);
    if (output.submitted) return end('error', 'submit_boundary', ids);
    const live = waited.liveViewUrl;
    const handOver = live
      ? {
          ...ids,
          liveViewUrl: live,
          holdExpiresAt: browserHold(deps),
          cartTotalCents: output.fee_cents,
        }
      : ids;

    if (output.outcome !== 'ready_for_parent') {
      return end(output.outcome, output.detail, HANDS_ON.has(output.outcome) ? handOver : ids);
    }
    const choiceIndex = output.choice_index;
    if (choiceIndex === null || choiceIndex >= input.choices.length) {
      return end('needs_human', 'choice_unreadable', handOver);
    }
    if (!live) return end('error', 'no_live_view', { ...ids, choiceIndex });
    const ready = {
      ...handOver,
      choiceIndex,
      checkoutUrl: sameProviderHttpsUrl(output.page_url, input.registrationUrl),
    };
    if (output.fee_cents !== null && output.fee_cents > input.maxPriceCents) {
      return end('needs_human', 'price_change', ready);
    }
    await input.onStep({ step: 'ready', choiceIndex, feeCents: output.fee_cents });
    return end('ready_for_parent', 'none', ready);
  } catch (error) {
    if (runId) await deps.api.cancelRun(runId).catch(() => undefined);
    if (error instanceof BrowserUseApiError) return end('error', 'api_error');
    throw error;
  }
}

/** How long Hale's browser stays open for the parent once the run has stopped. */
function browserHold(deps: BrowserUseEngineDeps): Date {
  return new Date(deps.now().getTime() + CHECKOUT_KEEP_ALIVE_SECONDS * 1000);
}
