import { describe, expect, it, vi } from 'vitest';
import type { SignupIdentity } from '../types';
import { browserUseApi } from './client';
import type { BrowserUseEngineDeps } from './engine';
import {
  type BrowserUsePlanInput,
  type PlanEngineStep,
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

const PAID = {
  outcome: 'paid',
  detail: 'none',
  confirmation_number: 'R-55120',
  amount_charged_cents: 9800,
};

type Logged = { method: string; path: string; body: Record<string, unknown> };

type Outputs = { plan: Record<string, unknown>; payment?: Record<string, unknown> };

/** `runningUntil`: a run reports `running` until the clock reaches that time (a long queue). */
function fakeFetch(
  outputs: Outputs,
  clock: { now: () => number; runningUntil?: Partial<Record<string, number>> } = {
    now: () => 0,
  },
) {
  const log: Logged[] = [];
  let runs = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const path = `${parsed.pathname.replace('/api/v4', '')}${parsed.search}`;
    log.push({
      method,
      path,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : {},
    });
    if (method === 'POST' && path === '/runs') {
      runs += 1;
      return Response.json({ id: `run-${runs}`, sessionId: 'bu-session-1' });
    }
    const run = /^\/runs\/(run-\d)/.exec(path)?.[1];
    if (run && path.endsWith('/status')) {
      const busy = clock.runningUntil?.[run];
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
    if (run) {
      const output = run === 'run-1' ? outputs.plan : outputs.payment;
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
  it('takes the first open choice, checks the cap on the cart total, then pays with the saved card', async () => {
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
      costUsd: '0.0500',
      sessionCostUsd: '0.090000',
    });
    expect(cap).toHaveBeenCalledWith(9800);
    expect(steps).toEqual([
      { step: 'checkout', choiceIndex: 1, cartTotalCents: 9800 },
      { step: 'spending_cap', amountCents: 9800, ok: true },
      {
        step: 'payment',
        outcome: 'completed',
        detail: 'none',
        amountChargedCents: 9800,
        confirmed: true,
      },
    ]);
    const [first, second] = runPosts(log);
    expect(first?.body.keepAlive).toBe(900);
    expect(Object.prototype.hasOwnProperty.call(first?.body ?? {}, 'keepAlive')).toBe(true);
    expect(String(first?.body.task)).toContain('# skill browser-use-plan-signup');
    expect(String(first?.body.task)).toContain('"rank": 2');
    expect(String(first?.body.task)).toContain('"max_price_cents": 10000');
    expect(String(first?.body.task)).not.toContain('grace@example.test');
    expect(String(second?.body.task)).toContain('# skill browser-use-saved-card-payment');
    expect(second?.body).toMatchObject({ sessionId: 'bu-session-1' });
    // The saved card is the city's; Hale sends no card at all.
    expect(second?.body).not.toHaveProperty('secretBindings');
    expect(second?.body).not.toHaveProperty('stripeLinkConnectionId');
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
    // One signup run and one payment run across all three sweeps.
    expect(runPosts(log).map((r) => String(r.body.task).split('\n')[0])).toEqual([
      '# skill browser-use-plan-signup',
      '# skill browser-use-saved-card-payment',
    ]);
    expect(third.steps.map((s) => s.step)).toEqual(['checkout', 'spending_cap', 'payment']);
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
      'paying:none after 1 runs',
      'paying:run-2 after 2 runs',
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
    expect(runPosts(log)).toHaveLength(1);
    expect(steps.map((s) => s.step)).toEqual(['checkout', 'spending_cap']);
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
