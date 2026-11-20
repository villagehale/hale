import { describe, expect, it, vi } from 'vitest';
import type { SignupIdentity } from '../types';
import { runBrowserUseAssistedSignup } from './assisted-engine';
import { browserUseApi } from './client';
import type { BrowserUseEngineDeps } from './engine';
import {
  type BrowserUsePlanInput,
  PlanEngineThrew,
  type PlanResumeToken,
  TAKEOVER_RESUME_RUN_MAX_COST_USD,
  runBrowserUsePlanSignup,
} from './plan-engine';

// VIL-718 · the plan engine's side of the takeover link. Fake Browser Use answers only, in the
// v4 shapes the recorded fixtures carry; no request leaves the process.
const NOW = new Date('2026-12-01T12:01:00.000Z');
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

function stopAt(outcome: string, detail: string): Record<string, unknown> {
  return {
    outcome,
    detail,
    choice_index: null,
    checkout_url: null,
    cart_total_cents: null,
    cart_currency: null,
    hold_minutes: null,
    saved_card_on_file: false,
    security_code_required: false,
    payment_details_entered: false,
  };
}

const CHECKOUT = {
  ...stopAt('reached_checkout', 'none'),
  choice_index: 0,
  checkout_url: 'https://register.example-rec.test/Checkout',
  cart_total_cents: 9800,
  cart_currency: 'cad',
  hold_minutes: 5,
  saved_card_on_file: true,
};

type Logged = { method: string; path: string; body: Record<string, unknown> };

/**
 * `first`: what the run the engine creates answers. `queued`: what the turn queued after a
 * takeover answers (a string, as a queued turn may answer). `queue`: how the queue behaves.
 */
function setup(options: {
  first?: Record<string, unknown>;
  queued?: unknown;
  queue?: 'dispatches' | 'dropped';
  assisted?: boolean;
}) {
  let clock = NOW.getTime();
  const log: Logged[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const path = `${parsed.pathname.replace('/api/v4', '')}${parsed.search}`;
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
    log.push({ method, path, body });
    if (method === 'POST' && path === '/runs') {
      return Response.json({ id: 'run-1', sessionId: 'bu-session-1' });
    }
    if (method === 'POST' && path === '/sessions/bu-session-1/queue') {
      return Response.json({ id: 7, sessionId: 'bu-session-1', runId: null, status: 'pending' });
    }
    if (method === 'GET' && path === '/sessions/bu-session-1/queue/7') {
      return options.queue === 'dropped'
        ? Response.json({ id: 7, sessionId: 'bu-session-1', runId: null, status: 'cancelled' })
        : Response.json({ id: 7, sessionId: 'bu-session-1', runId: 'run-q1', status: 'consumed' });
    }
    if (method === 'PATCH' && path === '/sessions/bu-session-1/cost-cap') return Response.json({});
    const run = /^\/runs\/(run-[a-z0-9]+)/.exec(path)?.[1];
    if (run && path.endsWith('/status')) return Response.json({ status: 'completed' });
    if (run && path.includes('/events')) {
      return Response.json({
        events: [
          {
            id: 1,
            type: run === 'run-1' ? 'browser.ready' : 'browser.reattached',
            data: { live_view_url: LIVE, browser_session_id: 'browser-1' },
          },
        ],
        nextAfter: null,
      });
    }
    if (run && path.endsWith('/cancel')) return Response.json({ id: run, status: 'cancelled' });
    if (run) {
      return Response.json({
        id: run,
        status: 'completed',
        sessionId: 'bu-session-1',
        output: run === 'run-1' ? options.first : options.queued,
        error: null,
        totalCostUsd: '0.0400',
      });
    }
    if (method === 'PATCH' && path.startsWith('/browsers/')) return Response.json({});
    if (path === '/sessions/bu-session-1/cost') {
      return Response.json({ sessionId: 'bu-session-1', totalCostUsd: '0.090000' });
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
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
  const checkpoints: PlanResumeToken[] = [];
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
    ],
    maxPriceCents: 10000,
    waiverAccepted: true,
    paymentEnabled: false,
    providerSession: {
      storageState: { cookies: [], origins: [] },
      browserUseProfileId: 'profile-seeded',
    },
    onProfileCreated: async () => undefined,
    proxyCountryCode: null,
    credentials: { username: 'ada-parent', password: 'fixture-pass', totp: null },
    checkSpendingCap: async () => ({ ok: true, reason: 'within' }),
    stillAuthorized: async () => true,
    onStep: async () => undefined,
    resume: null,
    waitUntil: new Date(NOW.getTime() + 60 * 60_000),
    onCheckpoint: async (token) => {
      checkpoints.push(token);
      return true;
    },
    ...overrides,
  };
  return { input, checkpoints };
}

const stopsBrowser = (log: Logged[]) =>
  log.some((r) => r.method === 'PATCH' && r.path === '/browsers/browser-1');

describe('VIL-718 · a stop only the parent can take over', () => {
  it('with the takeover link on, keeps the browser for a captcha and says how long it stays', async () => {
    const { deps, log } = setup({ first: stopAt('needs_human', 'captcha') });
    const { input } = plan({ takeover: true });
    const result = await runBrowserUsePlanSignup(input, deps);
    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'captcha',
      liveViewUrl: LIVE,
      sessionId: 'bu-session-1',
      runId: 'run-1',
      browserId: 'browser-1',
      sessionCostUsd: null,
    });
    if (result.outcome === 'checkpointed') throw new Error('not a checkpoint');
    expect(result.holdExpiresAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 900 * 1000).toISOString(),
    );
    // The browser stays open for the parent; the task told the agent the link is on.
    expect(stopsBrowser(log)).toBe(false);
    const created = log.find((r) => r.method === 'POST' && r.path === '/runs');
    expect(String(created?.body.task)).toContain('"takeover": true');
  });

  it('with the takeover link off, a captcha closes the browser and the task is unchanged', async () => {
    const { deps, log } = setup({ first: stopAt('needs_human', 'captcha') });
    const { input } = plan();
    const result = await runBrowserUsePlanSignup(input, deps);
    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'captcha',
      liveViewUrl: null,
      holdExpiresAt: null,
      sessionCostUsd: '0.090000',
    });
    expect(stopsBrowser(log)).toBe(true);
    const created = log.find((r) => r.method === 'POST' && r.path === '/runs');
    expect(String(created?.body.task)).not.toContain('takeover');
  });

  it('reads a passkey as the sign-in wall it always was while the link is off', async () => {
    const off = setup({ first: stopAt('needs_login', 'passkey') });
    const offResult = await runBrowserUsePlanSignup(plan().input, off.deps);
    expect(offResult).toMatchObject({ outcome: 'needs_login', detail: 'login_wall' });
    expect(offResult).toMatchObject({ liveViewUrl: LIVE, holdExpiresAt: null });

    const on = setup({ first: stopAt('needs_login', 'passkey') });
    const onResult = await runBrowserUsePlanSignup(plan({ takeover: true }).input, on.deps);
    expect(onResult).toMatchObject({
      outcome: 'needs_login',
      detail: 'passkey',
      liveViewUrl: LIVE,
    });
    if (onResult.outcome === 'checkpointed') throw new Error('not a checkpoint');
    expect(onResult.holdExpiresAt).not.toBeNull();
  });

  it('keeps a checkout hand-off exactly as before: the takeover link does not touch it', async () => {
    const { deps } = setup({ first: CHECKOUT });
    const result = await runBrowserUsePlanSignup(plan({ takeover: true }).input, deps);
    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'payment_off',
      liveViewUrl: LIVE,
      choiceIndex: 0,
    });
  });
});

describe('VIL-718 · picking the session back up after the parent is done', () => {
  const resume = {
    sessionId: 'bu-session-1',
    browserId: 'browser-1',
    purpose: 'captcha' as const,
    round: 1,
  };

  it('queues the next turn of the same session instead of a new run, and records it at once', async () => {
    const { deps, log } = setup({ queued: JSON.stringify(CHECKOUT) });
    const { input, checkpoints } = plan({ takeover: true, takeoverResume: resume });
    const result = await runBrowserUsePlanSignup(input, deps);

    expect(log.some((r) => r.method === 'POST' && r.path === '/runs')).toBe(false);
    const queued = log.find(
      (r) => r.method === 'POST' && r.path === '/sessions/bu-session-1/queue',
    );
    const text = String(queued?.body.text);
    // The resume skill, then the plan's own skill and facts, then the answer format.
    expect(text.indexOf('# skill browser-use-takeover-resume')).toBe(0);
    expect(text).toContain('# skill browser-use-plan-signup');
    expect(text).toContain('"takeover_done": "captcha"');
    // The parent signed in themselves: no credential alias for a turn with no secret bindings.
    expect(text).toContain('"credentials": null');
    expect(text).not.toContain('fixture-pass');
    expect(text).toContain('## Answer format');
    expect(queued?.body.interrupt).toBe(false);
    expect(
      log.find((r) => r.method === 'PATCH' && r.path === '/sessions/bu-session-1/cost-cap')?.body,
    ).toEqual({ maxCostUsd: TAKEOVER_RESUME_RUN_MAX_COST_USD });
    expect(checkpoints[0]).toEqual({
      phase: 'signup',
      runId: 'run-q1',
      sessionId: 'bu-session-1',
      browserId: 'browser-1',
      takeover: { purpose: 'captcha', round: 1 },
    });
    // The queued turn answered in JSON text; it reads like any run's answer.
    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'payment_off',
      choiceIndex: 0,
      cartTotalCents: 9800,
      runId: 'run-q1',
      liveViewUrl: LIVE,
    });
  });

  it('a second stop after the resume keeps its browser for another takeover', async () => {
    const { deps } = setup({ queued: JSON.stringify(stopAt('needs_login', 'verification_code')) });
    const result = await runBrowserUsePlanSignup(
      plan({ takeover: true, takeoverResume: resume }).input,
      deps,
    );
    expect(result).toMatchObject({
      outcome: 'needs_login',
      detail: 'verification_code',
      liveViewUrl: LIVE,
      runId: 'run-q1',
    });
  });

  it('a turn Browser Use drops ends the run as an error and stops the browser', async () => {
    const { deps, log } = setup({ queue: 'dropped' });
    const result = await runBrowserUsePlanSignup(
      plan({ takeover: true, takeoverResume: resume }).input,
      deps,
    );
    expect(result).toMatchObject({ outcome: 'error', detail: 'run_cancelled', liveViewUrl: null });
    expect(stopsBrowser(log)).toBe(true);
  });

  it('never waits on a takeover token as if its run were still going', async () => {
    const { deps } = setup({});
    const token: PlanResumeToken = {
      phase: 'takeover',
      runId: 'run-1',
      sessionId: 'bu-session-1',
      browserId: 'browser-1',
      purpose: 'captcha',
      loginLinkId: '00000000-0000-4000-8000-000000000001',
      expiresAt: NOW.toISOString(),
      round: 1,
      doneAt: NOW.toISOString(),
      lapsedAt: null,
    };
    await expect(runBrowserUsePlanSignup(plan({ resume: token }).input, deps)).rejects.toThrow(
      PlanEngineThrew,
    );
  });

  it('the assisted engine picks the same session back up too', async () => {
    const ready = {
      outcome: 'ready_for_parent',
      detail: 'none',
      choice_index: 0,
      page_url: 'https://register.example-rec.test/Enroll',
      fee_cents: 9800,
      submitted: false,
      payment_details_entered: false,
    };
    const { deps, log } = setup({ queued: JSON.stringify(ready), assisted: true });
    const { input, checkpoints } = plan({
      mode: 'assisted',
      takeover: true,
      takeoverResume: { ...resume, purpose: 'sign_in' },
    });
    const result = await runBrowserUseAssistedSignup(input, deps);
    expect(log.some((r) => r.method === 'POST' && r.path === '/runs')).toBe(false);
    const queued = log.find(
      (r) => r.method === 'POST' && r.path === '/sessions/bu-session-1/queue',
    );
    expect(String(queued?.body.text)).toContain('# skill browser-use-assisted-signup');
    expect(String(queued?.body.text)).toContain('"takeover_done": "sign_in"');
    expect(checkpoints[0]).toMatchObject({ phase: 'signup', runId: 'run-q1' });
    expect(result).toMatchObject({
      outcome: 'ready_for_parent',
      choiceIndex: 0,
      liveViewUrl: LIVE,
    });
  });
});
