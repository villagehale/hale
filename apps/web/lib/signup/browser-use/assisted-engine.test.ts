import { describe, expect, it, vi } from 'vitest';
import type { SignupIdentity } from '../types';
import {
  ASSISTED_SIGNUP_SKILL,
  runBrowserUseAssistedSignup,
  runBrowserUsePlanForMode,
} from './assisted-engine';
import { browserUseApi } from './client';
import { type BrowserUseEngineDeps, CHECKOUT_KEEP_ALIVE_SECONDS } from './engine';
import type { BrowserUsePlanInput, PlanEngineStep } from './plan-engine';

// Fake Browser Use responses only, in the shape the recorded v4 fixtures carry. No request
// leaves the process. Invented ActiveNet org, child and parent.
const NOW = new Date('2026-12-08T11:55:00.000Z');
const URL_ = 'https://anc.ca.apm.activecommunities.com/exampleville/activity/search/detail/123';
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

const READY = {
  outcome: 'ready_for_parent',
  detail: 'none',
  choice_index: 1,
  page_url: 'https://anc.ca.apm.activecommunities.com/exampleville/activity/enroll/123',
  fee_cents: 9800,
  submitted: false,
  payment_details_entered: false,
};

type Logged = { method: string; path: string; body: Record<string, unknown> };

function setup(output: Record<string, unknown>, status: 'completed' | 'running' = 'completed') {
  const log: Logged[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const path = `${parsed.pathname.replace('/api/v4', '')}${parsed.search}`;
    log.push({ method, path, body: typeof init.body === 'string' ? JSON.parse(init.body) : {} });
    if (method === 'POST' && path === '/runs') {
      return Response.json({ id: 'run-1', sessionId: 'bu-session-1' });
    }
    if (path === '/runs/run-1/status') return Response.json({ status });
    if (path.startsWith('/runs/run-1/events')) {
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
    if (path === '/runs/run-1/cancel') return Response.json({ id: 'run-1', status: 'cancelled' });
    if (path === '/runs/run-1') {
      return Response.json({
        id: 'run-1',
        status,
        sessionId: 'bu-session-1',
        output,
        error: null,
        totalCostUsd: '0.0400',
      });
    }
    if (method === 'PATCH' && path.startsWith('/browsers/')) return Response.json({});
    if (path === '/sessions/bu-session-1/cost') {
      return Response.json({ sessionId: 'bu-session-1', totalCostUsd: '0.060000' });
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
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
  const cap = vi.fn(async () => ({ ok: true, reason: 'within' }));
  const stillAuthorized = vi.fn(async () => true);
  const input: BrowserUsePlanInput = {
    mode: 'assisted',
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
    stillAuthorized,
    onStep: async (step) => {
      steps.push(step);
    },
    resume: null,
    waitUntil: new Date(NOW.getTime() + 60 * 60_000),
    onCheckpoint: async () => true,
    ...overrides,
  };
  return { input, steps, cap, stillAuthorized };
}

const runPosts = (log: Logged[]) => log.filter((r) => r.method === 'POST' && r.path === '/runs');
const browserStopped = (log: Logged[]) =>
  log.some((r) => r.method === 'PATCH' && r.path === '/browsers/browser-1');

describe('assisted plan engine (ActiveNet)', () => {
  it('fills the first open choice and hands the live browser over: one run, no payment', async () => {
    const { deps, log } = setup(READY);
    const { input, steps, cap, stillAuthorized } = plan();
    const result = await runBrowserUseAssistedSignup(input, deps);

    expect(result).toMatchObject({
      outcome: 'ready_for_parent',
      detail: 'none',
      choiceIndex: 1,
      liveViewUrl: LIVE,
      checkoutUrl: READY.page_url,
      cartTotalCents: 9800,
      amountChargedCents: null,
      confirmationNumber: null,
      holdExpiresAt: new Date(NOW.getTime() + CHECKOUT_KEEP_ALIVE_SECONDS * 1000),
    });
    expect(steps).toEqual([{ step: 'ready', choiceIndex: 1, feeCents: 9800 }]);
    // Hale never pays here: no cap is asked, no second run, the browser stays for the parent.
    expect(cap).not.toHaveBeenCalled();
    expect(stillAuthorized).not.toHaveBeenCalled();
    const posts = runPosts(log);
    expect(posts).toHaveLength(1);
    expect(browserStopped(log)).toBe(false);
    const body = posts[0]?.body ?? {};
    expect(body).toMatchObject({ keepAlive: CHECKOUT_KEEP_ALIVE_SECONDS, agentmail: false });
    expect(body).not.toHaveProperty('secretBindings');
    expect(body).not.toHaveProperty('stripeLinkConnectionId');
    const task = String(body.task);
    expect(task).toContain(`# skill ${ASSISTED_SIGNUP_SKILL}`);
    expect(task).toContain('"rank": 2');
    expect(task).toContain('"max_price_cents": 10000');
    // The parent ticks any waiver on the page themselves; their plan answer is not passed on.
    expect(task).not.toContain('waiver_accepted_by_parent');
    expect(task).not.toContain('grace@example.test');
  });

  it('stops the browser and hands nothing over when the agent went past the submit step', async () => {
    const { deps, log } = setup({ ...READY, submitted: true });
    const result = await runBrowserUseAssistedSignup(plan().input, deps);
    expect(result).toMatchObject({
      outcome: 'error',
      detail: 'submit_boundary',
      liveViewUrl: null,
    });
    expect(browserStopped(log)).toBe(true);

    const typed = setup({ ...READY, payment_details_entered: true });
    const paid = await runBrowserUseAssistedSignup(plan().input, typed.deps);
    expect(paid).toMatchObject({ outcome: 'error', detail: 'payment_boundary', liveViewUrl: null });
    expect(browserStopped(typed.log)).toBe(true);
  });

  it('hands a fee above the plan maximum to the parent instead of calling it ready', async () => {
    const { deps } = setup({ ...READY, fee_cents: 10001 });
    const { input, steps } = plan();
    const result = await runBrowserUseAssistedSignup(input, deps);
    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'price_change',
      liveViewUrl: LIVE,
      choiceIndex: 1,
    });
    expect(steps).toEqual([]);
  });

  it('refuses a choice index the plan does not have', async () => {
    const { deps } = setup({ ...READY, choice_index: 2 });
    const result = await runBrowserUseAssistedSignup(plan().input, deps);
    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'choice_unreadable',
      choiceIndex: null,
      liveViewUrl: LIVE,
    });
  });

  it('leaves the browser with the parent at a sign-in, a captcha or a queue that has not reached them', async () => {
    for (const stop of [
      { outcome: 'needs_login', detail: 'login_wall' },
      { outcome: 'needs_human', detail: 'captcha' },
      { outcome: 'not_open', detail: 'waiting_room' },
    ]) {
      const { deps, log } = setup({ ...READY, ...stop, choice_index: null, fee_cents: null });
      const result = await runBrowserUseAssistedSignup(plan().input, deps);
      expect(result).toMatchObject({ ...stop, liveViewUrl: LIVE });
      expect(browserStopped(log)).toBe(false);
    }
  });

  it('stops the browser on a sold-out answer: there is nothing for the parent to finish', async () => {
    const { deps, log } = setup({
      ...READY,
      outcome: 'sold_out',
      choice_index: null,
      fee_cents: null,
    });
    const result = await runBrowserUseAssistedSignup(plan().input, deps);
    expect(result).toMatchObject({ outcome: 'sold_out', liveViewUrl: null, choiceIndex: null });
    expect(browserStopped(log)).toBe(true);
  });

  it('hands the parent the browser still holding the place in line when the run deadline passes', async () => {
    const { deps, log } = setup(READY, 'running');
    const result = await runBrowserUseAssistedSignup(plan().input, deps);
    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'timeout',
      liveViewUrl: LIVE,
    });
    expect(log.some((r) => r.path === '/runs/run-1/cancel')).toBe(true);
    expect(browserStopped(log)).toBe(false);
  });

  it('is the engine every assisted plan gets; an auto plan still gets the paying engine', async () => {
    const assisted = setup(READY);
    const filled = await runBrowserUsePlanForMode(plan().input, assisted.deps);
    expect(filled.outcome).toBe('ready_for_parent');
    expect(runPosts(assisted.log)).toHaveLength(1);
    expect(String(runPosts(assisted.log)[0]?.body.task)).toContain(
      `# skill ${ASSISTED_SIGNUP_SKILL}`,
    );

    // Positive control: the same answer to an auto plan goes to the plan engine's own skill.
    const auto = setup(READY);
    await runBrowserUsePlanForMode(plan({ mode: 'auto' }).input, auto.deps);
    expect(String(runPosts(auto.log)[0]?.body.task)).toContain('# skill browser-use-plan-signup');
  });
});
