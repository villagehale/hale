import { describe, expect, it, vi } from 'vitest';
import type { SignupIdentity } from '../types';
import { browserUseApi } from './client';
import type { BrowserUseEngineDeps } from './engine';
import {
  type BrowserUsePlanInput,
  type PlanEngineStep,
  PlanEngineThrew,
  type PlanPayingToken,
  type PlanResumeToken,
  planFacts,
  releasePlanRun,
  runBrowserUsePlanSignup,
  settleBrowserUsePlanPayment,
} from './plan-engine';

// Fake Browser Use responses only, in the shape the recorded v4 fixtures carry.
// No request leaves the process.
const NOW = new Date('2026-12-01T11:55:00.000Z');
const URL_ = 'https://register.example-rec.test/Clients/BookMe4LandingPages/CoursesLandingPage';
const LIVE = 'https://live.browser-use.com/s/fixture-live-view-token';
const IDENTITY: SignupIdentity = {
  childFirstName: 'Ada',
  childLastName: 'Lovelace',
  childDob: '2022-04-01',
  parentFirstName: 'Grace',
  parentEmail: 'grace@example.test',
  postalCode: 'A1A1A1',
  teenager: false,
};

const CHECKOUT = {
  outcome: 'reached_checkout',
  detail: 'none',
  choice_index: 1,
  checkout_url: 'https://register.example-rec.test/Checkout',
  cart_total_cents: 9800,
  cart_currency: 'cad',
  hold_minutes: 5,
  saved_card_on_file: true,
  security_code_required: false,
  payment_details_entered: false,
};

/** The last page before "place order": the saved card chosen, nothing placed. */
const REVIEW = {
  outcome: 'ready_to_place',
  detail: 'none',
  total_cents: 9800,
  currency: 'cad',
  tax_cents: 0,
  fees_cents: 0,
  saved_card_selected: true,
  order_placed: false,
};

const PAID = {
  outcome: 'paid',
  detail: 'none',
  confirmation_number: 'R-55120',
  amount_charged_cents: 9800,
};

type Logged = { method: string; path: string; body: Record<string, unknown> };

type Outputs = {
  plan: Record<string, unknown>;
  review?: Record<string, unknown>;
  payment?: Record<string, unknown>;
  /** The review run ends with no answer: its run fails, Browser Use answers 500, or the network drops. */
  reviewBreaks?: 'run_failed' | 'api_error' | 'network';
};

/** `runningUntil`: a run reports `running` until the clock reaches that time (a long queue). */
function fakeFetch(
  outputs: Outputs,
  clock: { now: () => number; runningUntil?: Partial<Record<string, number>> } = {
    now: () => 0,
  },
) {
  const log: Logged[] = [];
  let runs = 0;
  // Each run answers as the skill it was created with; a run this process never created
  // (a payment an earlier sweep started) answers as the payment.
  const skillOf = new Map<string, string>();
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const path = `${parsed.pathname.replace('/api/v4', '')}${parsed.search}`;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    log.push({ method, path, body });
    if (method === 'POST' && path === '/runs') {
      runs += 1;
      skillOf.set(`run-${runs}`, String(body.task).split('\n')[0] ?? '');
      return Response.json({ id: `run-${runs}`, sessionId: 'bu-session-1' });
    }
    const run = /^\/runs\/(run-\d)/.exec(path)?.[1];
    const review = run !== undefined && skillOf.get(run) === '# skill browser-use-checkout-review';
    if (run && path.endsWith('/status')) {
      const busy = clock.runningUntil?.[run];
      if (review && outputs.reviewBreaks === 'run_failed')
        return Response.json({ status: 'failed' });
      return Response.json({
        status: busy !== undefined && clock.now() < busy ? 'running' : 'completed',
      });
    }
    if (run && path.includes('/events')) {
      return Response.json({
        events: [
          {
            id: 1,
            type: 'browser.ready',
            data: { live_view_url: LIVE, browser_session_id: 'browser-1' },
          },
        ],
        nextAfter: null,
      });
    }
    if (run && path.endsWith('/cancel')) return Response.json({ id: run, status: 'cancelled' });
    if (review && outputs.reviewBreaks === 'api_error') return new Response('{}', { status: 500 });
    if (review && outputs.reviewBreaks === 'network') throw new TypeError('fetch failed');
    if (run) {
      const skill = skillOf.get(run);
      const output =
        skill === '# skill browser-use-plan-signup'
          ? outputs.plan
          : skill === '# skill browser-use-checkout-review'
            ? (outputs.review ?? REVIEW)
            : outputs.payment;
      return Response.json({
        id: run,
        status: 'completed',
        sessionId: 'bu-session-1',
        output,
        error: null,
        totalCostUsd: run === 'run-1' ? '0.0400' : '0.0100',
      });
    }
    if (method === 'PATCH' && path.startsWith('/browsers/')) return Response.json({});
    if (path === '/sessions/bu-session-1/cost') {
      return Response.json({ sessionId: 'bu-session-1', totalCostUsd: '0.090000' });
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  return { fetchImpl, log };
}

function setup(outputs: Outputs, runningUntil?: Partial<Record<string, number>>) {
  let clock = NOW.getTime();
  const { fetchImpl, log } = fakeFetch(outputs, { now: () => clock, runningUntil });
  const deps: BrowserUseEngineDeps = {
    api: browserUseApi({ apiKey: 'test-key', fetch: fetchImpl }),
    seeder: null,
    loadTask: async (skill) => `# skill ${skill}`,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return {
    deps,
    log,
    setClock: (at: number) => {
      clock = at;
    },
  };
}

function plan(overrides: Partial<BrowserUsePlanInput> = {}) {
  const steps: PlanEngineStep[] = [];
  const checkpoints: PlanResumeToken[] = [];
  const cap = vi.fn(async (_cents: number) => ({ ok: true, reason: 'within' }));
  const input: BrowserUsePlanInput = {
    mode: 'auto',
    correlationId: 'offer-fixture',
    registrationUrl: URL_,
    identity: IDENTITY,
    fieldsAllowed: ['child_first_name', 'child_last_name', 'child_dob', 'session'],
    choices: [
      {
        label: 'Preschool Swim Sat 9:00',
        startsAt: '2027-01-09T14:00:00.000Z',
        endsAt: '2027-01-09T14:45:00.000Z',
      },
      {
        label: 'Preschool Swim Sun 10:00',
        startsAt: '2027-01-10T15:00:00.000Z',
        endsAt: '2027-01-10T15:45:00.000Z',
      },
    ],
    maxPriceCents: 10000,
    waiverAccepted: true,
    paymentEnabled: true,
    providerSession: {
      storageState: { cookies: [], origins: [] },
      browserUseProfileId: 'profile-seeded',
    },
    onProfileCreated: async () => undefined,
    proxyCountryCode: null,
    checkSpendingCap: cap,
    stillAuthorized: async () => true,
    onStep: async (step) => {
      steps.push(step);
    },
    resume: null,
    waitUntil: new Date(NOW.getTime() + 60 * 60_000),
    onCheckpoint: async (token) => {
      checkpoints.push(token);
      return true;
    },
    ...overrides,
  };
  return { input, steps, cap, checkpoints };
}

const runPosts = (log: Logged[]) => log.filter((r) => r.method === 'POST' && r.path === '/runs');

describe('day-before plan engine', () => {
  it('takes the first open choice, checks the cap on the cart total, reads the final total, then pays with the saved card', async () => {
    const { deps, log } = setup({ plan: CHECKOUT, payment: PAID });
    const { input, steps, cap } = plan();
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'completed',
      detail: 'none',
      choiceIndex: 1,
      confirmationNumber: 'R-55120',
      amountChargedCents: 9800,
      liveViewUrl: null,
      costUsd: '0.0600',
      sessionCostUsd: '0.090000',
    });
    expect(cap.mock.calls).toEqual([[9800], [9800]]);
    expect(steps).toEqual([
      { step: 'checkout', choiceIndex: 1, cartTotalCents: 9800 },
      { step: 'spending_cap', amountCents: 9800, ok: true },
      {
        step: 'final_total',
        checkoutTotalCents: 9800,
        finalTotalCents: 9800,
        taxCents: 0,
        feesCents: 0,
        currency: 'cad',
        detail: 'none',
        ok: true,
      },
      { step: 'spending_cap', amountCents: 9800, ok: true },
      {
        step: 'payment',
        outcome: 'completed',
        detail: 'none',
        amountChargedCents: 9800,
        confirmed: true,
      },
    ]);
    const [first, review, pay] = runPosts(log);
    expect(first?.body.keepAlive).toBe(900);
    expect(Object.prototype.hasOwnProperty.call(first?.body ?? {}, 'keepAlive')).toBe(true);
    expect(String(first?.body.task)).toContain('# skill browser-use-plan-signup');
    expect(String(first?.body.task)).toContain('"rank": 2');
    expect(String(first?.body.task)).toContain('"max_price_cents": 10000');
    expect(String(first?.body.task)).not.toContain('grace@example.test');
    // The review reads the final total in the same browser, and is never told a figure to expect.
    expect(String(review?.body.task)).toContain('# skill browser-use-checkout-review');
    expect(String(review?.body.task)).toContain('"waiver_accepted_by_parent": true');
    expect(String(review?.body.task)).not.toContain('9800');
    expect(review?.body).toMatchObject({
      sessionId: 'bu-session-1',
      keepAlive: 900,
      maxCostUsd: 1,
    });
    expect(review?.body).not.toHaveProperty('secretBindings');
    expect(String(pay?.body.task)).toContain('# skill browser-use-saved-card-payment');
    expect(pay?.body).toMatchObject({ sessionId: 'bu-session-1' });
    // The saved card is the city's; Hale sends no card at all.
    expect(pay?.body).not.toHaveProperty('secretBindings');
    expect(pay?.body).not.toHaveProperty('stripeLinkConnectionId');
  });

  it('never pays when the spending cap refuses: the cart stays on the live browser', async () => {
    const { deps, log } = setup({ plan: CHECKOUT, payment: PAID });
    const { input, steps } = plan({
      checkSpendingCap: async () => ({ ok: false, reason: 'over' }),
    });
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'spending_cap',
      liveViewUrl: LIVE,
    });
    expect(runPosts(log)).toHaveLength(1);
    expect(steps.map((s) => s.step)).toEqual(['checkout', 'spending_cap']);
  });

  it("never pays once the parent's yes no longer stands: the browser stops, no payment run", async () => {
    const { deps, log } = setup({ plan: CHECKOUT, payment: PAID });
    const stillAuthorized = vi.fn(async () => false);
    const { input, steps, cap } = plan({ stillAuthorized });
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'cancelled',
      detail: 'authorization_lapsed',
      liveViewUrl: null,
      confirmationNumber: null,
      amountChargedCents: null,
    });
    // Checked after the cap, just before the card: the last moment that matters.
    expect(cap).toHaveBeenCalledWith(9800);
    expect(stillAuthorized).toHaveBeenCalledTimes(1);
    expect(runPosts(log)).toHaveLength(1);
    expect(steps.map((s) => s.step)).toEqual(['checkout', 'spending_cap']);
    expect(log.some((r) => r.method === 'PATCH' && r.path === '/browsers/browser-1')).toBe(true);
  });

  it.each([
    ['a total above the plan maximum', { cart_total_cents: 10001 }, 'price_change'],
    ['no saved card on the account', { saved_card_on_file: false }, 'no_saved_card'],
    ['a security code prompt', { security_code_required: true }, 'security_code'],
  ])(
    'hands the cart to the parent on %s, before the cap or any payment',
    async (_name, change, detail) => {
      const { deps, log } = setup({ plan: { ...CHECKOUT, ...change }, payment: PAID });
      const { input, cap } = plan();
      const result = await runBrowserUsePlanSignup(input, deps);

      expect(result).toMatchObject({ outcome: 'needs_human', detail, liveViewUrl: LIVE });
      expect(cap).not.toHaveBeenCalled();
      expect(runPosts(log)).toHaveLength(1);
    },
  );

  it('never reports a registration whose charge does not match the cart', async () => {
    const { deps } = setup({ plan: CHECKOUT, payment: { ...PAID, amount_charged_cents: 12000 } });
    const result = await runBrowserUsePlanSignup(plan().input, deps);
    expect(result).toMatchObject({ outcome: 'needs_human', detail: 'charge_mismatch' });
  });

  it('refuses a choice index the plan does not have', async () => {
    const { deps, log } = setup({ plan: { ...CHECKOUT, choice_index: 2 } });
    const { input, steps } = plan();
    const result = await runBrowserUsePlanSignup(input, deps);
    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'choice_unreadable',
      choiceIndex: null,
    });
    expect(steps).toEqual([]);
    expect(runPosts(log)).toHaveLength(1);
  });

  it('passes a sold-out answer through without a live view', async () => {
    const { deps } = setup({
      plan: { ...CHECKOUT, outcome: 'sold_out', choice_index: null, cart_total_cents: null },
    });
    const result = await runBrowserUsePlanSignup(plan().input, deps);
    expect(result).toMatchObject({ outcome: 'sold_out', liveViewUrl: null, choiceIndex: null });
  });

  it.each(['session_not_found', 'captcha'] as const)(
    'closes the browser on needs_human %s',
    async (detail) => {
      const { deps, log } = setup({
        plan: {
          ...CHECKOUT,
          outcome: 'needs_human',
          detail,
          choice_index: null,
          cart_total_cents: null,
        },
      });
      const result = await runBrowserUsePlanSignup(plan().input, deps);
      expect(result).toMatchObject({ outcome: 'needs_human', detail, liveViewUrl: null });
      expect(log.some((r) => r.method === 'PATCH' && r.path === '/browsers/browser-1')).toBe(true);
    },
  );
});

const MIN = 60_000;
const cancels = (log: Logged[]) => log.filter((r) => r.path.endsWith('/cancel'));
const browserStops = (log: Logged[]) => log.filter((r) => r.method === 'PATCH');
const skills = (log: Logged[]) => runPosts(log).map((r) => String(r.body.task).split('\n')[0]);
const PLAN_AND_REVIEW = ['# skill browser-use-plan-signup', '# skill browser-use-checkout-review'];

describe('the final total, read before the saved card is charged', () => {
  it('pays exactly the reviewed final total, tax included, not the cart total before the card', async () => {
    // $80.00 in the cart, 13% tax shown only once the card is chosen: $80.00 + $10.40 = $90.40.
    const { deps, log } = setup({
      plan: { ...CHECKOUT, cart_total_cents: 8000 },
      review: { ...REVIEW, total_cents: 9040, tax_cents: 1040 },
      payment: { ...PAID, amount_charged_cents: 9040 },
    });
    const { input, cap, checkpoints } = plan();
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'completed',
      amountChargedCents: 9040,
      cartTotalCents: 9040,
    });
    expect(cap.mock.calls).toEqual([[8000], [9040]]);
    expect(checkpoints.filter((c) => c.phase === 'paying')[0]).toMatchObject({
      cartTotalCents: 9040,
    });
    expect(String(runPosts(log)[2]?.body.task)).toContain('"amount_cents": 9040');
  });

  it('a charge of the pre-tax cart total is a mismatch against the final total', async () => {
    const { deps } = setup({
      plan: { ...CHECKOUT, cart_total_cents: 8000 },
      review: { ...REVIEW, total_cents: 9040, tax_cents: 1040 },
      payment: { ...PAID, amount_charged_cents: 8000 },
    });
    const result = await runBrowserUsePlanSignup(plan().input, deps);
    expect(result).toMatchObject({ outcome: 'needs_human', detail: 'charge_mismatch' });
  });

  it('tax that pushes the final total over the maximum hands the cart back: price_change, never paying', async () => {
    // $180.00 + 13% tax ($23.40) = $203.40 against a $200.00 maximum.
    const { deps, log } = setup({
      plan: { ...CHECKOUT, cart_total_cents: 18000 },
      review: { ...REVIEW, total_cents: 20340, tax_cents: 2340 },
      payment: PAID,
    });
    const { input, steps, cap, checkpoints } = plan({ maxPriceCents: 20000 });
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'price_change',
      liveViewUrl: LIVE,
      cartTotalCents: 20340,
      confirmationNumber: null,
      amountChargedCents: null,
    });
    expect(skills(log)).toEqual(PLAN_AND_REVIEW);
    expect(checkpoints.map((c) => c.phase)).not.toContain('paying');
    expect(cap.mock.calls).toEqual([[18000]]);
    expect(steps).toEqual([
      { step: 'checkout', choiceIndex: 1, cartTotalCents: 18000 },
      { step: 'spending_cap', amountCents: 18000, ok: true },
      {
        step: 'final_total',
        checkoutTotalCents: 18000,
        finalTotalCents: 20340,
        taxCents: 2340,
        feesCents: 0,
        currency: 'cad',
        detail: 'price_change',
        ok: false,
      },
    ]);
    // The cart stays on the live browser for the parent.
    expect(browserStops(log)).toEqual([]);
  });

  it.each([
    ['no total read', { total_cents: null }],
    ['a total of zero', { total_cents: 0 }],
    // Tax and fees only add: a final below the cart total is a subtotal, not the total.
    ['a total below the cart total', { total_cents: 9000 }],
    ['a review that stops with no reason', { outcome: 'needs_human' }],
  ])('%s is total_unread: the cart goes back to the parent unpaid', async (_name, change) => {
    const { deps, log } = setup({
      plan: CHECKOUT,
      review: { ...REVIEW, ...change },
      payment: PAID,
    });
    const { input, steps, cap, checkpoints } = plan();
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'total_unread',
      liveViewUrl: LIVE,
      cartTotalCents: 9800,
    });
    expect(skills(log)).toEqual(PLAN_AND_REVIEW);
    expect(checkpoints.map((c) => c.phase)).not.toContain('paying');
    expect(cap).toHaveBeenCalledTimes(1);
    expect(steps.at(-1)).toMatchObject({ step: 'final_total', detail: 'total_unread', ok: false });
  });

  it.each([
    ['another currency', { currency: 'usd' }],
    ['no currency on the final page', { currency: null }],
  ])('%s than the cart is currency_unknown, never paid', async (_name, change) => {
    const { deps, log } = setup({
      plan: CHECKOUT,
      review: { ...REVIEW, ...change },
      payment: PAID,
    });
    const { input, checkpoints } = plan();
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'currency_unknown',
      liveViewUrl: LIVE,
    });
    expect(skills(log)).toEqual(PLAN_AND_REVIEW);
    expect(checkpoints.map((c) => c.phase)).not.toContain('paying');
  });

  it('no currency on either page is currency_unknown, never paid: two unknowns are not a match', async () => {
    const { deps, log } = setup({
      plan: { ...CHECKOUT, cart_currency: null },
      review: { ...REVIEW, currency: null },
      payment: PAID,
    });
    const { input, steps, checkpoints } = plan();
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'currency_unknown',
      liveViewUrl: LIVE,
      amountChargedCents: null,
    });
    expect(skills(log)).toEqual(PLAN_AND_REVIEW);
    expect(checkpoints.map((c) => c.phase)).not.toContain('paying');
    expect(steps.at(-1)).toMatchObject({
      step: 'final_total',
      currency: null,
      detail: 'currency_unknown',
      ok: false,
    });
  });

  it('runs the spending cap again on the final total: a refusal there is never paid', async () => {
    // $90.00 in the cart passes; $99.00 with fees does not, under a $95.00 cap.
    const cap = vi.fn(async (cents: number) =>
      cents <= 9500 ? { ok: true, reason: 'within' } : { ok: false, reason: 'over the cap' },
    );
    const { deps, log } = setup({
      plan: { ...CHECKOUT, cart_total_cents: 9000 },
      review: { ...REVIEW, total_cents: 9900, fees_cents: 900 },
      payment: PAID,
    });
    const { input, steps, checkpoints } = plan({ checkSpendingCap: cap });
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'spending_cap',
      liveViewUrl: LIVE,
      cartTotalCents: 9900,
    });
    expect(cap.mock.calls).toEqual([[9000], [9900]]);
    expect(steps.slice(2)).toEqual([
      {
        step: 'final_total',
        checkoutTotalCents: 9000,
        finalTotalCents: 9900,
        taxCents: 0,
        feesCents: 900,
        currency: 'cad',
        detail: 'none',
        ok: true,
      },
      { step: 'spending_cap', amountCents: 9900, ok: false },
    ]);
    expect(skills(log)).toEqual(PLAN_AND_REVIEW);
    expect(checkpoints.map((c) => c.phase)).not.toContain('paying');
  });

  it('a review that says it placed the order may have charged the card: its own detail, the browser kept, a payment row, no payment run', async () => {
    const { deps, log } = setup({
      plan: CHECKOUT,
      review: { ...REVIEW, order_placed: true },
      payment: PAID,
    });
    const { input, steps, checkpoints } = plan();
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'review_placed_order',
      liveViewUrl: LIVE,
      sessionId: 'bu-session-1',
      browserId: 'browser-1',
      confirmationNumber: null,
      amountChargedCents: null,
    });
    expect(skills(log)).toEqual(PLAN_AND_REVIEW);
    expect(checkpoints.map((c) => c.phase)).not.toContain('paying');
    // Whatever the provider now shows stays on the live browser to be checked.
    expect(browserStops(log)).toEqual([]);
    expect(steps.slice(-2)).toEqual([
      {
        step: 'final_total',
        checkoutTotalCents: 9800,
        finalTotalCents: 9800,
        taxCents: 0,
        feesCents: 0,
        currency: 'cad',
        detail: 'review_placed_order',
        ok: false,
      },
      // The amount is unknown, never zero: nothing here says the card was not charged.
      {
        step: 'payment',
        outcome: 'needs_human',
        detail: 'review_placed_order',
        amountChargedCents: null,
        confirmed: false,
      },
    ]);
  });

  it.each([
    ['the saved card was not chosen', { saved_card_selected: false }, 'no_saved_card'],
    [
      'a code was asked for',
      { outcome: 'needs_human', detail: 'verification_code', total_cents: null },
      'verification_code',
    ],
  ])('%s: the cart goes back to the parent unpaid', async (_name, change, detail) => {
    const { deps, log } = setup({
      plan: CHECKOUT,
      review: { ...REVIEW, ...change },
      payment: PAID,
    });
    const { input, checkpoints } = plan();
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({ outcome: 'needs_human', detail, liveViewUrl: LIVE });
    expect(skills(log)).toEqual(PLAN_AND_REVIEW);
    expect(checkpoints.map((c) => c.phase)).not.toContain('paying');
  });

  it('a review still running at its deadline is cancelled and handed back: timeout, never paying', async () => {
    const { deps, log } = setup(
      { plan: CHECKOUT, payment: PAID },
      { 'run-2': NOW.getTime() + 24 * 60 * MIN },
    );
    const { input, steps, checkpoints } = plan({ waitUntil: new Date(NOW.getTime() + 10 * MIN) });
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({ outcome: 'needs_human', detail: 'timeout', liveViewUrl: LIVE });
    expect(cancels(log).map((r) => r.path)).toEqual(['/runs/run-2/cancel']);
    expect(skills(log)).toEqual(PLAN_AND_REVIEW);
    expect(checkpoints.map((c) => c.phase)).not.toContain('paying');
    expect(steps.at(-2)).toMatchObject({
      step: 'final_total',
      finalTotalCents: null,
      detail: 'timeout',
      ok: false,
    });
  });

  it('a signup run that ends at the sweep budget still leaves the review its own window', async () => {
    // The sweep's budget is spent when checkout is reached; the review takes 90 seconds.
    const { deps } = setup({ plan: CHECKOUT, payment: PAID }, { 'run-2': NOW.getTime() + 90_000 });
    const result = await runBrowserUsePlanSignup(plan({ waitUntil: NOW }).input, deps);
    expect(result).toMatchObject({ outcome: 'completed', confirmationNumber: 'R-55120' });
  });

  it("re-checks the parent's yes after the review: a lapse then is never paid", async () => {
    const stillAuthorized = vi
      .fn<() => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const { deps, log } = setup({ plan: CHECKOUT, payment: PAID });
    const { input, checkpoints } = plan({ stillAuthorized });
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'cancelled',
      detail: 'authorization_lapsed',
      liveViewUrl: null,
    });
    expect(stillAuthorized).toHaveBeenCalledTimes(2);
    expect(skills(log)).toEqual(PLAN_AND_REVIEW);
    expect(checkpoints.map((c) => c.phase)).not.toContain('paying');
    expect(browserStops(log).map((r) => r.path)).toEqual(['/browsers/browser-1']);
  });

  it('with the payment kill switch off the plan stops at checkout: payment_off, no review, never paying', async () => {
    const { deps, log } = setup({ plan: CHECKOUT, payment: PAID });
    const { input, steps, checkpoints } = plan({ paymentEnabled: false });
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'payment_off',
      liveViewUrl: LIVE,
      cartTotalCents: 9800,
    });
    expect(skills(log)).toEqual(['# skill browser-use-plan-signup']);
    expect(checkpoints.map((c) => c.phase)).toEqual(['signup']);
    expect(steps.map((s) => s.step)).toEqual(['checkout', 'spending_cap']);
  });
});

describe('what the run charged, as the engine itself knows it', () => {
  const DECLINED = {
    outcome: 'declined',
    detail: 'none',
    confirmation_number: null,
    amount_charged_cents: null,
  };
  // Every hand-back before the payment run is `nothing`. Once a payment run exists, or the
  // review placed the order, Hale did not read a charge it can stand behind: `unknown`,
  // never zero. A read charge is its cents.
  it.each([
    ['a confirmed payment', { plan: CHECKOUT, payment: PAID }, {}, 'none', { cents: 9800 }],
    [
      'tax over the maximum',
      {
        plan: { ...CHECKOUT, cart_total_cents: 18000 },
        review: { ...REVIEW, total_cents: 20340, tax_cents: 2340 },
        payment: PAID,
      },
      { maxPriceCents: 20000 },
      'price_change',
      'nothing',
    ],
    [
      'payments switched off',
      { plan: CHECKOUT, payment: PAID },
      { paymentEnabled: false },
      'payment_off',
      'nothing',
    ],
    [
      'a final total it could not read',
      { plan: CHECKOUT, review: { ...REVIEW, total_cents: null }, payment: PAID },
      {},
      'total_unread',
      'nothing',
    ],
    [
      'no currency on the final page',
      { plan: CHECKOUT, review: { ...REVIEW, currency: null }, payment: PAID },
      {},
      'currency_unknown',
      'nothing',
    ],
    [
      'a review that placed the order',
      { plan: CHECKOUT, review: { ...REVIEW, order_placed: true }, payment: PAID },
      {},
      'review_placed_order',
      'unknown',
    ],
    [
      'a declined saved card',
      { plan: CHECKOUT, payment: DECLINED },
      {},
      'card_declined',
      'nothing',
    ],
    [
      'a payment that says it went but not for how much',
      { plan: CHECKOUT, payment: { ...PAID, amount_charged_cents: null } },
      {},
      'charge_unverified',
      'unknown',
    ],
    [
      'a payment run whose answer cannot be read',
      { plan: CHECKOUT, payment: { outcome: 'paid' } },
      {},
      'unreadable_output',
      'unknown',
    ],
  ] as const)('%s', async (_name, outputs, overrides, detail, charged) => {
    const { deps } = setup(outputs);
    const result = await runBrowserUsePlanSignup(plan(overrides).input, deps);
    expect(result).toMatchObject({ detail, charged });
  });

  it('a payment whose run id was never written may have charged: unknown', async () => {
    const { deps } = setup({ plan: CHECKOUT, payment: PAID });
    const result = await settleBrowserUsePlanPayment(
      {
        resume: {
          phase: 'paying',
          runId: null,
          sessionId: 'bu-session-1',
          browserId: 'browser-1',
          choiceIndex: 1,
          cartTotalCents: 9800,
          holdExpiresAt: null,
          costUsd: '0.0400',
        },
        waitUntil: new Date(NOW.getTime() + 60 * MIN),
        onStep: async () => undefined,
      },
      deps,
    );
    expect(result).toMatchObject({ detail: 'unconfirmed', charged: 'unknown' });
  });

  // The review is told never to place the order, yet once its run exists only an answer read
  // in full can rule a charge out: one never read is `unknown`, with a payment row of unknown
  // amount and the browser left on what the provider now shows.
  it.each([
    ['a review whose run failed', { reviewBreaks: 'run_failed' }, 'run_failed'],
    [
      'a review whose answer cannot be read',
      { review: { outcome: 'ready_to_place' } },
      'unreadable_output',
    ],
    ['a review Browser Use will not report', { reviewBreaks: 'api_error' }, 'api_error'],
  ] as const)('%s may have placed the order: unknown', async (_name, outputs, detail) => {
    const { deps, log } = setup({ plan: CHECKOUT, payment: PAID, ...outputs });
    const { input, steps, checkpoints } = plan();
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail,
      charged: 'unknown',
      amountChargedCents: null,
      liveViewUrl: LIVE,
    });
    expect(skills(log)).toEqual(PLAN_AND_REVIEW);
    expect(checkpoints.map((c) => c.phase)).not.toContain('paying');
    expect(browserStops(log)).toEqual([]);
    expect(steps.at(-1)).toEqual({
      step: 'payment',
      outcome: 'needs_human',
      detail,
      amountChargedCents: null,
      confirmed: false,
    });
  });

  it('a review cancelled at its deadline may have placed the order: unknown', async () => {
    const { deps } = setup(
      { plan: CHECKOUT, payment: PAID },
      { 'run-2': NOW.getTime() + 24 * 60 * MIN },
    );
    const { input, steps } = plan({ waitUntil: new Date(NOW.getTime() + 10 * MIN) });
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({ detail: 'timeout', charged: 'unknown', liveViewUrl: LIVE });
    expect(steps.at(-1)).toMatchObject({ step: 'payment', detail: 'timeout', confirmed: false });
  });

  it('a throw once the review is under way says so; a throw before it does not', async () => {
    const during = setup({ plan: CHECKOUT, payment: PAID, reviewBreaks: 'network' });
    const thrown = await runBrowserUsePlanSignup(plan().input, during.deps).catch((e) => e);
    expect(thrown).toBeInstanceOf(PlanEngineThrew);
    expect(thrown.reviewStarted).toBe(true);

    const before = setup({ plan: CHECKOUT, payment: PAID });
    const capDown = plan({
      checkSpendingCap: async () => {
        throw new Error('cap store down');
      },
    });
    const early = await runBrowserUsePlanSignup(capDown.input, before.deps).catch((e) => e);
    expect(early).toBeInstanceOf(PlanEngineThrew);
    expect(early.reviewStarted).toBe(false);
    expect(skills(before.log)).toEqual(['# skill browser-use-plan-signup']);
  });
});

describe('a plan run longer than one sweep', () => {
  it('checkpoints at the sweep budget without cancelling, and the next sweep finishes the same run', async () => {
    // The town's queue holds the run for 25 minutes; each sweep may wait 10.
    const { deps, log, setClock } = setup(
      { plan: CHECKOUT, payment: PAID },
      { 'run-1': NOW.getTime() + 25 * MIN },
    );
    const first = plan({ waitUntil: new Date(NOW.getTime() + 10 * MIN) });
    const paused = await runBrowserUsePlanSignup(first.input, deps);

    expect(paused).toEqual({
      outcome: 'checkpointed',
      resume: {
        phase: 'signup',
        runId: 'run-1',
        sessionId: 'bu-session-1',
        browserId: 'browser-1',
      },
    });
    // The run keeps its place: nothing cancelled, the browser left running.
    expect(cancels(log)).toEqual([]);
    expect(browserStops(log)).toEqual([]);
    expect(first.steps).toEqual([]);
    // Written as soon as the run existed, so a sweep the platform kills still resumes it.
    expect(first.checkpoints[0]).toEqual({
      phase: 'signup',
      runId: 'run-1',
      sessionId: 'bu-session-1',
      browserId: null,
    });

    setClock(NOW.getTime() + 11 * MIN);
    if (paused.outcome !== 'checkpointed') throw new Error('not checkpointed');
    const second = plan({ resume: paused.resume, waitUntil: new Date(NOW.getTime() + 21 * MIN) });
    expect(await runBrowserUsePlanSignup(second.input, deps)).toMatchObject({
      outcome: 'checkpointed',
    });
    setClock(NOW.getTime() + 22 * MIN);
    const third = plan({ resume: paused.resume, waitUntil: new Date(NOW.getTime() + 32 * MIN) });
    const done = await runBrowserUsePlanSignup(third.input, deps);

    expect(done).toMatchObject({ outcome: 'completed', confirmationNumber: 'R-55120' });
    // One signup run, one review and one payment run across all three sweeps.
    expect(runPosts(log).map((r) => String(r.body.task).split('\n')[0])).toEqual([
      '# skill browser-use-plan-signup',
      '# skill browser-use-checkout-review',
      '# skill browser-use-saved-card-payment',
    ]);
    expect(third.steps.map((s) => s.step)).toEqual([
      'checkout',
      'spending_cap',
      'final_total',
      'spending_cap',
      'payment',
    ]);
  });

  it('writes the paying checkpoint before it creates the payment run', async () => {
    const { deps, log } = setup({ plan: CHECKOUT, payment: PAID });
    const order: string[] = [];
    const { input } = plan({
      onCheckpoint: async (token) => {
        order.push(`${token.phase}:${token.runId ?? 'none'} after ${runPosts(log).length} runs`);
        return true;
      },
    });
    await runBrowserUsePlanSignup(input, deps);

    expect(order).toEqual([
      'signup:run-1 after 1 runs',
      'paying:none after 2 runs',
      'paying:run-3 after 3 runs',
    ]);
  });

  it('a plan taken back before its paying checkpoint is stored is never paid', async () => {
    const { deps, log } = setup({ plan: CHECKOUT, payment: PAID });
    const { input, steps } = plan({
      onCheckpoint: async (token) => token.phase !== 'paying',
    });
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'cancelled',
      detail: 'authorization_lapsed',
      liveViewUrl: null,
      confirmationNumber: null,
      amountChargedCents: null,
    });
    expect(runPosts(log).map((r) => String(r.body.task).split('\n')[0])).toEqual([
      '# skill browser-use-plan-signup',
      '# skill browser-use-checkout-review',
    ]);
    expect(steps.map((s) => s.step)).toEqual([
      'checkout',
      'spending_cap',
      'final_total',
      'spending_cap',
    ]);
    expect(browserStops(log).map((r) => r.path)).toEqual(['/browsers/browser-1']);
  });

  it('a resumed payment waits on its own run and never creates another', async () => {
    const { deps, log } = setup({ plan: CHECKOUT, payment: PAID });
    const resume: PlanPayingToken = {
      phase: 'paying',
      runId: 'run-2',
      sessionId: 'bu-session-1',
      browserId: 'browser-1',
      choiceIndex: 1,
      cartTotalCents: 9800,
      holdExpiresAt: null,
      costUsd: '0.0400',
    };
    const steps: PlanEngineStep[] = [];
    // No identity, consent or saved session: a payment under way is read before any of them.
    const result = await settleBrowserUsePlanPayment(
      {
        resume,
        waitUntil: new Date(NOW.getTime() + 60 * MIN),
        onStep: async (step) => {
          steps.push(step);
        },
      },
      deps,
    );

    expect(result).toMatchObject({
      outcome: 'completed',
      confirmationNumber: 'R-55120',
      amountChargedCents: 9800,
      choiceIndex: 1,
      costUsd: '0.0500',
    });
    expect(runPosts(log)).toEqual([]);
    expect(cancels(log)).toEqual([]);
    expect(steps.map((s) => s.step)).toEqual(['payment']);
  });

  it('a payment whose run id was never written is not paid again: unconfirmed, for the parent', async () => {
    const { deps, log } = setup({ plan: CHECKOUT, payment: PAID });
    const result = await settleBrowserUsePlanPayment(
      {
        resume: {
          phase: 'paying',
          runId: null,
          sessionId: 'bu-session-1',
          browserId: 'browser-1',
          choiceIndex: 1,
          cartTotalCents: 9800,
          holdExpiresAt: null,
          costUsd: '0.0400',
        },
        waitUntil: new Date(NOW.getTime() + 60 * MIN),
        onStep: async () => undefined,
      },
      deps,
    );

    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'unconfirmed',
      confirmationNumber: null,
      cartTotalCents: 9800,
      choiceIndex: 1,
    });
    expect(runPosts(log)).toEqual([]);
  });

  it('releasing a checkpointed run cancels it and stops its browser', async () => {
    const { deps, log } = setup({ plan: CHECKOUT });
    const cost = await releasePlanRun(
      { phase: 'signup', runId: 'run-1', sessionId: 'bu-session-1', browserId: 'browser-1' },
      deps,
    );
    expect(cost).toBe('0.090000');
    expect(cancels(log).map((r) => r.path)).toEqual(['/runs/run-1/cancel']);
    expect(browserStops(log).map((r) => r.path)).toEqual(['/browsers/browser-1']);
  });
});

describe('plan facts', () => {
  it('ranks the choices and leaves their labels out when the session slot is not granted', () => {
    const { input } = plan({ fieldsAllowed: ['child_first_name'] });
    const facts = planFacts(input) as {
      choices: Record<string, unknown>[];
      child: Record<string, unknown>;
    };
    expect(facts.choices).toEqual([
      {
        rank: 1,
        label: undefined,
        starts_at: '2027-01-09T14:00:00.000Z',
        ends_at: '2027-01-09T14:45:00.000Z',
      },
      {
        rank: 2,
        label: undefined,
        starts_at: '2027-01-10T15:00:00.000Z',
        ends_at: '2027-01-10T15:45:00.000Z',
      },
    ]);
    expect(facts.child).toEqual({
      first_name: 'Ada',
      last_name: undefined,
      date_of_birth: undefined,
    });
    const derived = planFacts(plan({ identity: { ...IDENTITY, childDob: null } }).input) as {
      child: Record<string, unknown>;
    };
    expect(derived.child.date_of_birth).toBeUndefined();
    // Positive control: with the slot granted, the label goes.
    const granted = planFacts(plan().input) as { choices: Record<string, unknown>[] };
    expect(granted.choices[0]?.label).toBe('Preschool Swim Sat 9:00');
  });
});
