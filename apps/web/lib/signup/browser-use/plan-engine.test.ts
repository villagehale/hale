import { describe, expect, it, vi } from 'vitest';
import type { SignupIdentity } from '../types';
import { browserUseApi } from './client';
import type { BrowserUseEngineDeps } from './engine';
import {
  type BrowserUsePlanInput,
  type PlanEngineStep,
  planFacts,
  runBrowserUsePlanSignup,
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

function fakeFetch(outputs: { plan: Record<string, unknown>; payment?: Record<string, unknown> }) {
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
    if (run && path.endsWith('/status')) return Response.json({ status: 'completed' });
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

function setup(outputs: { plan: Record<string, unknown>; payment?: Record<string, unknown> }) {
  const { fetchImpl, log } = fakeFetch(outputs);
  let clock = NOW.getTime();
  const deps: BrowserUseEngineDeps = {
    api: browserUseApi({ apiKey: 'test-key', fetch: fetchImpl }),
    seeder: null,
    loadTask: async (skill) => `# skill ${skill}`,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  return { deps, log };
}

function plan(overrides: Partial<BrowserUsePlanInput> = {}) {
  const steps: PlanEngineStep[] = [];
  const cap = vi.fn(async (_cents: number) => ({ ok: true, reason: 'within' }));
  const input: BrowserUsePlanInput = {
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
    ...overrides,
  };
  return { input, steps, cap };
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
    // Positive control: with the slot granted, the label goes.
    const granted = planFacts(plan().input) as { choices: Record<string, unknown>[] };
    expect(granted.choices[0]?.label).toBe('Preschool Swim Sat 9:00');
  });
});
