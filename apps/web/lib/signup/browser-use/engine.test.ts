import { describe, expect, it, vi } from 'vitest';
import type { SignupIdentity } from '../types';
import { BrowserUseApiError, browserUseApi } from './client';
import {
  type BrowserUseEngineDeps,
  type BrowserUseSignupInput,
  CHECKOUT_KEEP_ALIVE_SECONDS,
  readBrowserUseConfirmation,
  runBrowserUseSignup,
} from './engine';
import browserCreated from './fixtures/browser-created.json';
import profileCreated from './fixtures/profile-created.json';
import runCreated from './fixtures/run-created.json';
import eventsReady from './fixtures/run-events-ready.json';
import checkoutSummary from './fixtures/run-summary-checkout.json';
import confirmationSummary from './fixtures/run-summary-confirmation.json';
import failedSummary from './fixtures/run-summary-failed.json';

// Recorded Browser Use API v4 responses only. No request leaves the process.
const NOW = new Date('2026-10-21T15:00:00.000Z');

const IDENTITY: SignupIdentity = {
  childFirstName: 'Ada',
  childLastName: 'Lovelace',
  childDob: '2022-04-01',
  parentFirstName: 'Grace',
  parentEmail: 'grace@example.test',
  postalCode: 'M5V2T6',
  teenager: false,
};

type Route = { status?: number; body?: unknown };

function fixtureFetch(routes: Record<string, Route | Route[]>) {
  const requests: { method: string; path: string; body: unknown; headers: Headers }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const key = `${method} ${parsed.pathname.replace('/api/v4', '')}`;
    requests.push({
      method,
      path: `${parsed.pathname}${parsed.search}`,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: new Headers(init.headers),
    });
    const entry = routes[key];
    const route = Array.isArray(entry) ? (entry.length > 1 ? entry.shift() : entry[0]) : entry;
    if (!route) throw new Error(`unexpected ${key}`);
    const status = route.status ?? 200;
    if (status === 204) return new Response(null, { status });
    return Response.json(route.body ?? {}, { status });
  });
  return { fetchImpl, requests };
}

const RUN = `/runs/${runCreated.id}`;

function happyRoutes(summary: unknown = checkoutSummary): Record<string, Route | Route[]> {
  return {
    'POST /profiles': { body: profileCreated },
    'POST /browsers': { body: browserCreated },
    [`PATCH /browsers/${browserCreated.id}`]: { body: { ...browserCreated, status: 'stopped' } },
    'POST /runs': { body: runCreated },
    [`GET ${RUN}/status`]: [{ body: { status: 'running' } }, { body: { status: 'completed' } }],
    [`GET ${RUN}/events`]: { body: eventsReady },
    [`GET ${RUN}`]: { body: summary },
    [`POST ${RUN}/cancel`]: { body: { ...runCreated, status: 'cancelled' } },
  };
}

function summaryWith(output: Record<string, unknown>) {
  return {
    ...checkoutSummary,
    output: { ...checkoutSummary.output, ...output },
  };
}

function setup(
  routes: Record<string, Route | Route[]>,
  overrides: Partial<BrowserUseEngineDeps> = {},
) {
  const { fetchImpl, requests } = fixtureFetch(routes);
  const seeded: string[] = [];
  let clock = NOW.getTime();
  const deps: BrowserUseEngineDeps = {
    api: browserUseApi({ apiKey: 'test-key', fetch: fetchImpl }),
    seeder: {
      async seed(cdpUrl) {
        seeded.push(cdpUrl);
      },
    },
    loadTask: async (skill) => `# skill ${skill}\nStop at checkout.`,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
    ...overrides,
  };
  return { deps, requests, seeded, fetchImpl };
}

function input(overrides: Partial<BrowserUseSignupInput> = {}): BrowserUseSignupInput {
  return {
    correlationId: 'offer-fixture',
    payment: null,
    registrationUrl: 'https://anc.ca.apm.activecommunities.com/toronto/activity/search/detail/123',
    identity: IDENTITY,
    fieldsAllowed: ['child_first_name', 'child_last_name', 'child_dob', 'session'],
    session: {
      label: 'Preschool Swim — Sat 9:00',
      startsAt: '2026-11-07T14:00:00.000Z',
      endsAt: '2026-11-07T14:45:00.000Z',
    },
    approvedPriceCents: 9800,
    providerSession: {
      storageState: {
        cookies: [
          {
            name: 'JSESSIONID',
            value: 'cookie-value-fixture',
            domain: '.activecommunities.com',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      },
      browserUseProfileId: null,
    },
    onProfileCreated: async () => undefined,
    ...overrides,
  };
}

describe('browser use signup engine', () => {
  it('seeds a fresh profile, runs to checkout and hands back the live view', async () => {
    const { deps, requests, seeded } = setup(happyRoutes());
    const onProfileCreated = vi.fn(async () => undefined);
    const result = await runBrowserUseSignup(input({ onProfileCreated }), deps);

    expect(result).toMatchObject({
      outcome: 'reached_checkout',
      detail: 'none',
      liveViewUrl: 'https://live.browser-use.com/s/fixture-live-view-token',
      checkoutUrl: 'https://anc.ca.apm.activecommunities.com/toronto/checkout',
      cartTotalCents: 9800,
      confirmationNumber: null,
      runId: runCreated.id,
      sessionId: runCreated.sessionId,
      costUsd: '0.0243',
    });
    // The page said 8 minutes; that is shorter than the kept-alive browser.
    expect(result.holdExpiresAt?.toISOString()).toBe('2026-10-21T15:08:02.000Z');
    expect(onProfileCreated).toHaveBeenCalledWith(profileCreated.id);
    expect(seeded).toEqual([browserCreated.cdpUrl]);
    const order = requests.map((r) => `${r.method} ${r.path.split('?')[0]}`);
    expect(order.slice(0, 4)).toEqual([
      'POST /api/v4/profiles',
      'POST /api/v4/browsers',
      `PATCH /api/v4/browsers/${browserCreated.id}`,
      'POST /api/v4/runs',
    ]);
    for (const request of requests) {
      expect(request.headers.get('X-Browser-Use-API-Key')).toBe('test-key');
      expect(request.headers.get('Authorization')).toBeNull();
    }
  });

  it('sends only the granted fields, no secrets, no payment link, and keeps the cart alive', async () => {
    const { deps, requests } = setup(happyRoutes());
    await runBrowserUseSignup(input(), deps);
    const run = requests.find((r) => r.method === 'POST' && r.path === '/api/v4/runs');
    const body = run?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      browserSettings: { profileId: profileCreated.id, record: false },
      keepAlive: CHECKOUT_KEEP_ALIVE_SECONDS,
      agentmail: false,
    });
    expect(body).not.toHaveProperty('secretBindings');
    expect(body).not.toHaveProperty('opVaultId');
    expect(body).not.toHaveProperty('stripeLinkConnectionId');
    const task = String(body.task);
    expect(task).toContain('# skill browser-use-signup');
    expect(task).toContain('"first_name": "Ada"');
    expect(task).toContain('"date_of_birth": "2022-04-01"');
    expect(task).not.toContain('grace@example.test');
    expect(task).not.toContain('M5V2T6');
    expect(task).not.toContain('Grace');
    expect(task).not.toContain('cookie-value-fixture');
    expect(JSON.stringify(body.outputSchema)).toContain('reached_checkout');
  });

  it('reuses a profile already seeded from this session', async () => {
    const { deps, requests, seeded } = setup(happyRoutes());
    const base = input();
    const result = await runBrowserUseSignup(
      input({
        providerSession: { ...base.providerSession, browserUseProfileId: 'profile-seeded' },
      }),
      deps,
    );
    expect(result.outcome).toBe('reached_checkout');
    expect(seeded).toEqual([]);
    expect(requests.some((r) => r.path.startsWith('/api/v4/profiles'))).toBe(false);
    expect(requests.some((r) => r.path.startsWith('/api/v4/browsers'))).toBe(false);
  });

  it.each([
    ['waitlist', 'none'],
    ['sold_out', 'none'],
  ] as const)('returns %s without a live view', async (outcome, detail) => {
    const summary = summaryWith({ outcome, detail, checkout_url: null, cart_total_cents: null });
    const { deps } = setup(happyRoutes(summary));
    const result = await runBrowserUseSignup(input(), deps);
    expect(result).toMatchObject({ outcome, detail, liveViewUrl: null, checkoutUrl: null });
  });

  it.each([
    ['needs_login', 'login_wall'],
    ['needs_human', 'captcha'],
    ['needs_human', 'verification_code'],
  ] as const)(
    'returns %s (%s) with the live view so the parent can step in',
    async (outcome, detail) => {
      const summary = summaryWith({ outcome, detail, checkout_url: null, cart_total_cents: null });
      const { deps } = setup(happyRoutes(summary));
      const result = await runBrowserUseSignup(input(), deps);
      expect(result).toMatchObject({
        outcome,
        detail,
        liveViewUrl: 'https://live.browser-use.com/s/fixture-live-view-token',
        holdExpiresAt: null,
      });
    },
  );

  it('turns a cart above the approved price into needs_human', async () => {
    const { deps } = setup(happyRoutes(summaryWith({ cart_total_cents: 12500 })));
    const result = await runBrowserUseSignup(input(), deps);
    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'price_change',
      cartTotalCents: 12500,
      checkoutUrl: null,
    });
  });

  it('refuses a run that says it touched payment fields', async () => {
    const { deps } = setup(happyRoutes(summaryWith({ payment_details_entered: true })));
    const result = await runBrowserUseSignup(input(), deps);
    expect(result).toMatchObject({
      outcome: 'error',
      detail: 'payment_boundary',
      liveViewUrl: null,
    });
  });

  it('drops a checkout url on another site', async () => {
    const summary = summaryWith({ checkout_url: 'https://pay.example-phish.test/checkout' });
    const { deps } = setup(happyRoutes(summary));
    const result = await runBrowserUseSignup(input(), deps);
    expect(result.outcome).toBe('reached_checkout');
    expect(result.checkoutUrl).toBeNull();
  });

  it('returns error when checkout was reached but no live view was announced', async () => {
    const routes = happyRoutes();
    routes[`GET ${RUN}/events`] = { body: { events: [], nextAfter: null, hasMore: false } };
    const { deps } = setup(routes);
    const result = await runBrowserUseSignup(input(), deps);
    expect(result).toMatchObject({ outcome: 'error', detail: 'no_live_view' });
  });

  it('returns error on a failed run', async () => {
    const routes = happyRoutes(failedSummary);
    routes[`GET ${RUN}/status`] = { body: { status: 'failed' } };
    const { deps } = setup(routes);
    const result = await runBrowserUseSignup(input(), deps);
    expect(result).toMatchObject({ outcome: 'error', detail: 'run_failed', costUsd: '0.0012' });
  });

  it('returns error on output that does not match the schema', async () => {
    const { deps } = setup(happyRoutes({ ...checkoutSummary, output: { outcome: 'paid' } }));
    const result = await runBrowserUseSignup(input(), deps);
    expect(result).toMatchObject({ outcome: 'error', detail: 'unreadable_output' });
  });

  it('cancels a run that outlives the deadline', async () => {
    const routes = happyRoutes();
    routes[`GET ${RUN}/status`] = { body: { status: 'running' } };
    const { deps, requests } = setup(routes);
    const result = await runBrowserUseSignup(input(), deps);
    expect(result).toMatchObject({ outcome: 'error', detail: 'timeout', runId: runCreated.id });
    expect(requests.some((r) => r.method === 'POST' && r.path === `/api/v4${RUN}/cancel`)).toBe(
      true,
    );
  });

  it('returns api_error when Browser Use refuses the run', async () => {
    const routes = happyRoutes();
    routes['POST /runs'] = { status: 402, body: { detail: 'insufficient credits' } };
    const { deps } = setup(routes);
    const result = await runBrowserUseSignup(input(), deps);
    expect(result).toMatchObject({ outcome: 'error', detail: 'api_error', runId: null });
  });

  it('names a missing seeder instead of running logged out', async () => {
    const { deps, requests } = setup(happyRoutes(), { seeder: null });
    const result = await runBrowserUseSignup(input(), deps);
    expect(result).toMatchObject({ outcome: 'error', detail: 'seed_unavailable' });
    expect(requests).toHaveLength(0);
  });

  it('stops the seed browser even when seeding fails', async () => {
    const { deps, requests } = setup(happyRoutes(), {
      seeder: {
        async seed() {
          throw new Error('cdp closed');
        },
      },
    });
    const result = await runBrowserUseSignup(input(), deps);
    expect(result).toMatchObject({ outcome: 'error', detail: 'seed_failed' });
    expect(requests.some((r) => r.method === 'PATCH')).toBe(true);
    expect(requests.some((r) => r.path === '/api/v4/runs')).toBe(false);
  });

  it('exports BrowserUseApiError for callers', () => {
    expect(new BrowserUseApiError(500, '/runs').message).toBe('browser use /runs answered 500');
  });
});

describe('browser use confirmation read', () => {
  const CONFIRM = `/runs/${confirmationSummary.id}`;
  function confirmationRoutes(summary: unknown = confirmationSummary) {
    return {
      'POST /runs': { body: { ...runCreated, id: confirmationSummary.id } },
      [`GET ${CONFIRM}/status`]: { body: { status: 'completed' } },
      [`GET ${CONFIRM}/events`]: { body: { events: [], nextAfter: null, hasMore: false } },
      [`GET ${CONFIRM}`]: { body: summary },
    };
  }

  it('reads the confirmation number in the same session', async () => {
    const { deps, requests } = setup(confirmationRoutes());
    const result = await readBrowserUseConfirmation({ sessionId: runCreated.sessionId }, deps);
    expect(result).toEqual({
      outcome: 'confirmed',
      confirmationNumber: 'RCPT-0042817',
      costUsd: '0.0029',
    });
    const body = requests[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({ sessionId: runCreated.sessionId, agentmail: false });
    expect(String(body.task)).toContain('# skill browser-use-confirmation');
    expect(body).not.toHaveProperty('browserSettings');
  });

  it('returns not_confirmed when the page is not a confirmation', async () => {
    const summary = {
      ...confirmationSummary,
      output: { on_confirmation_page: false, confirmation_number: null },
    };
    const { deps } = setup(confirmationRoutes(summary));
    const result = await readBrowserUseConfirmation({ sessionId: runCreated.sessionId }, deps);
    expect(result.outcome).toBe('not_confirmed');
  });
});
