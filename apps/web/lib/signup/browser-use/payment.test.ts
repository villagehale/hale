import { describe, expect, it, vi } from 'vitest';
import {
  LinkApiError,
  linkAuthorizeUrl,
  linkOAuthApi,
  linkOAuthConfigFromEnv,
  linkWalletApi,
} from '../link/client';
import type { SignupPaymentWallet } from '../link/wallet';
import type { SignupIdentity } from '../types';
import { browserUseApi } from './client';
import {
  type BrowserUseEngineDeps,
  type BrowserUseSignupInput,
  runBrowserUseSignup,
} from './engine';
import { browserUseSignupPaymentEnabled } from './flag';

// Mocked Browser Use and Link responses only. No request leaves the process.
const NOW = new Date('2026-10-21T15:00:00.000Z');
const URL_ = 'https://register.example-rec.test/swim/123';
const LIVE = 'https://live.browser-use.com/s/fixture-live-view-token';
const LIVE_PAY = 'https://live.browser-use.com/s/fixture-pay-view-token';
const CARD = '4000009990001984';
const CVC = '731';
const IDENTITY: SignupIdentity = {
  childFirstName: 'Ada',
  childLastName: 'Lovelace',
  childDob: '2022-04-01',
  parentFirstName: 'Grace',
  parentEmail: 'grace@example.test',
  postalCode: 'M5V2T6',
  teenager: false,
};

const CHECKOUT_OUTPUT = {
  outcome: 'reached_checkout',
  detail: 'none',
  checkout_url: 'https://register.example-rec.test/checkout',
  cart_total_cents: 9800,
  hold_minutes: 8,
  payment_details_entered: false,
  opens_at: null,
  cart_currency: 'cad',
  payment_hosts: ['js.stripe.com', 'not a host/'],
};

const PAID_OUTPUT = {
  outcome: 'paid',
  detail: 'none',
  confirmation_number: 'R-55120',
  amount_charged_cents: 9800,
};

type Logged = { method: string; path: string; body: unknown; headers: Headers };

function fakeFetch(options: {
  signup?: Record<string, unknown>;
  payment?: Record<string, unknown>;
  statuses?: string[];
}) {
  const log: Logged[] = [];
  const statuses = [...(options.statuses ?? ['approved'])];
  let runs = 0;
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const parsed = new URL(url);
    const method = init.method ?? 'GET';
    const path = `${parsed.pathname.replace('/api/v4', '')}${parsed.search}`;
    let body: unknown;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    log.push({ method, path, body, headers: new Headers(init.headers) });
    if (parsed.hostname === 'api.link.com') {
      const request = { id: 'lsrq_1', amount: 9800, currency: 'cad' };
      if (method === 'POST' && path === '/spend_requests') {
        return Response.json({
          ...request,
          status: 'pending_approval',
          approval_url: 'https://app.link.com/activity/approve/lsrq_1',
        });
      }
      if (path === '/spend_requests/lsrq_1') {
        const status = statuses.length > 1 ? statuses.shift() : statuses[0];
        return Response.json({ ...request, status });
      }
      if (path === '/spend_requests/lsrq_1?include=card') {
        return Response.json({
          ...request,
          status: 'approved',
          card: {
            number: CARD,
            cvc: CVC,
            exp_month: 6,
            exp_year: 2029,
            billing_address: { postal_code: 'M5V2T6' },
          },
        });
      }
      if (path === '/spend_requests/lsrq_1/cancel') {
        return Response.json({ ...request, status: 'canceled' });
      }
    }
    if (method === 'POST' && path === '/runs') {
      runs += 1;
      return Response.json({ id: `run-${runs}`, sessionId: 'bu-session-1' });
    }
    const run = /^\/runs\/(run-\d)/.exec(path)?.[1];
    if (run && path.endsWith('/status')) return Response.json({ status: 'completed' });
    if (run && path.includes('/events')) {
      const live = run === 'run-1' ? LIVE : LIVE_PAY;
      return Response.json({
        events: [{ id: 1, type: 'browser.ready', data: { live_view_url: live } }],
      });
    }
    if (run && path.endsWith('/cancel')) return Response.json({ id: run, status: 'cancelled' });
    if (run) {
      const output =
        run === 'run-1'
          ? { ...CHECKOUT_OUTPUT, ...options.signup }
          : { ...PAID_OUTPUT, ...options.payment };
      return Response.json({
        id: run,
        status: 'completed',
        sessionId: 'bu-session-1',
        output,
        error: null,
        totalCostUsd: '0.0300',
      });
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  return { fetchImpl, log };
}

function setup(options: Parameters<typeof fakeFetch>[0] = {}) {
  const { fetchImpl, log } = fakeFetch(options);
  let clock = NOW.getTime();
  const deps: BrowserUseEngineDeps = {
    api: browserUseApi({ apiKey: 'test-key', fetch: fetchImpl }),
    seeder: null,
    loadTask: async (skill) => `# ${skill}`,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => new Date(clock),
  };
  const wallet: SignupPaymentWallet = {
    kind: 'stripe_link_agent_wallet',
    approvalWindowMinutes: 5,
    api: linkWalletApi('liwltoken_fixture', fetchImpl),
  };
  return { deps, log, wallet };
}

function input(
  payment: SignupPaymentWallet | null,
  overrides: Partial<BrowserUseSignupInput> = {},
): BrowserUseSignupInput {
  return {
    correlationId: 'offer-fixture',
    registrationUrl: URL_,
    identity: IDENTITY,
    fieldsAllowed: ['child_first_name', 'session'],
    session: { label: 'Swim', startsAt: '2026-11-07T14:00:00Z', endsAt: '2026-11-07T14:45:00Z' },
    approvedPriceCents: 9800,
    payment,
    providerSession: {
      storageState: {
        cookies: [
          {
            name: 'sid',
            value: 'c',
            domain: '.example-rec.test',
            path: '/',
            expires: -1,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
          },
        ],
        origins: [],
      },
      browserUseProfileId: 'profile-existing',
    },
    onProfileCreated: async () => undefined,
    ...overrides,
  };
}

const runBodies = (log: Logged[]) =>
  log
    .filter((entry) => entry.method === 'POST' && entry.path === '/runs')
    .map((entry) => entry.body as Record<string, unknown>);
const linkCalls = (log: Logged[]) =>
  log.filter((entry) => entry.path.startsWith('/spend_requests'));

describe('VIL-558 go-live: charged carts stop, $0 may submit', () => {
  it('stops a charged cart at checkout and never asks Link, even with a wallet', async () => {
    const { deps, log, wallet } = setup();
    const result = await runBrowserUseSignup(input(wallet), deps);
    expect(result).toMatchObject({
      outcome: 'reached_checkout',
      detail: 'none',
      cartTotalCents: 9800,
      confirmationNumber: null,
      liveViewUrl: LIVE,
    });
    expect(linkCalls(log)).toHaveLength(0);
    expect(runBodies(log)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain(CARD);
  });

  it('refuses a charged cart the agent submitted', async () => {
    const { deps, log, wallet } = setup({ signup: { submitted: true } });
    const result = await runBrowserUseSignup(input(wallet), deps);
    expect(result).toMatchObject({
      outcome: 'error',
      detail: 'submit_boundary',
      liveViewUrl: null,
    });
    expect(linkCalls(log)).toHaveLength(0);
    expect(runBodies(log)).toHaveLength(1);
  });

  it('completes a $0 class the agent submitted after the parent approved', async () => {
    const { deps, log, wallet } = setup({
      signup: {
        cart_total_cents: 0,
        submitted: true,
        confirmation_number: 'FREE-1',
      },
    });
    const result = await runBrowserUseSignup(input(wallet, { approvedPriceCents: 0 }), deps);
    expect(result).toMatchObject({
      outcome: 'completed',
      detail: 'none',
      cartTotalCents: 0,
      confirmationNumber: 'FREE-1',
      liveViewUrl: null,
    });
    expect(linkCalls(log)).toHaveLength(0);
    expect(runBodies(log)).toHaveLength(1);
  });

  it('hands a $0 cart that was not submitted back at checkout', async () => {
    const { deps, log, wallet } = setup({ signup: { cart_total_cents: 0, submitted: false } });
    const result = await runBrowserUseSignup(input(wallet, { approvedPriceCents: 0 }), deps);
    expect(result).toMatchObject({
      outcome: 'reached_checkout',
      cartTotalCents: 0,
      liveViewUrl: LIVE,
    });
    expect(linkCalls(log)).toHaveLength(0);
  });

  it('turns a cart above the approved price into needs_human before any payment', async () => {
    const { deps, log, wallet } = setup({ signup: { cart_total_cents: 9900 } });
    const result = await runBrowserUseSignup(input(wallet), deps);
    expect(result).toMatchObject({ outcome: 'needs_human', detail: 'price_change' });
    expect(linkCalls(log)).toHaveLength(0);
  });

  it('stops at checkout with no Link call when the parent has no wallet', async () => {
    const { deps, log } = setup();
    const result = await runBrowserUseSignup(input(null), deps);
    expect(result).toMatchObject({
      outcome: 'reached_checkout',
      detail: 'none',
      liveViewUrl: LIVE,
    });
    expect(linkCalls(log)).toHaveLength(0);
    expect(runBodies(log)).toHaveLength(1);
  });

  it('treats a payment field filled during the signup run as a boundary breach', async () => {
    const { deps, wallet } = setup({ signup: { payment_details_entered: true } });
    const result = await runBrowserUseSignup(input(wallet), deps);
    expect(result).toMatchObject({ outcome: 'error', detail: 'payment_boundary' });
  });

  it('returns a rush with the open time the page states', async () => {
    const { deps, wallet } = setup({
      signup: {
        outcome: 'rush',
        detail: 'timed_open',
        checkout_url: null,
        cart_total_cents: null,
        opens_at: 'Monday, January 5 at 7:00 AM',
      },
    });
    const result = await runBrowserUseSignup(input(wallet), deps);
    expect(result).toMatchObject({
      outcome: 'rush',
      detail: 'timed_open',
      opensAt: 'Monday, January 5 at 7:00 AM',
      liveViewUrl: null,
    });
  });
});

describe('link oauth', () => {
  const config = {
    clientId: 'client_fixture',
    clientSecret: 'secret_fixture',
    publishableKey: 'pk_test_fixture',
  };

  it('refreshes with the publishable key and returns the rotated refresh token', async () => {
    const fetchImpl = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({
        access_token: 'liwltoken_new',
        refresh_token: 'liwlrefresh_new',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: 'payment_methods.agentic userinfo:read',
      }),
    );
    const tokens = await linkOAuthApi(config, fetchImpl).refresh('liwlrefresh_old');
    expect(tokens).toEqual({
      accessToken: 'liwltoken_new',
      refreshToken: 'liwlrefresh_new',
      expiresInSeconds: 3600,
      scope: 'payment_methods.agentic userinfo:read',
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://login.link.com/auth/token');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer pk_test_fixture');
    const form = new URLSearchParams(String(init.body));
    expect(form.get('grant_type')).toBe('refresh_token');
    expect(form.get('refresh_token')).toBe('liwlrefresh_old');
    expect(form.get('client_id')).toBe('client_fixture');
  });

  it('throws a status-only error that carries no token', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const error = await linkOAuthApi(config, fetchImpl)
      .refresh('liwlrefresh_old')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LinkApiError);
    expect(String((error as Error).message)).not.toContain('liwlrefresh_old');
  });

  it('builds the parent sign-in URL with the wallet scope and PKCE', () => {
    const url = new URL(
      linkAuthorizeUrl({
        config,
        redirectUri: 'https://app.villagehale.com/api/link/callback',
        state: 'state-1',
        codeChallenge: 'challenge-1',
      }),
    );
    expect(url.origin).toBe('https://login.link.com');
    expect(url.searchParams.get('scope')).toBe('payment_methods.agentic userinfo:read');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('key')).toBe('pk_test_fixture');
  });

  it('names a missing OAuth client', () => {
    expect(linkOAuthConfigFromEnv({ STRIPE_PUBLISHABLE_KEY: 'pk_test' })).toEqual({
      config: null,
      skipped: 'not_configured',
      missing: ['LINK_OAUTH_CLIENT_ID', 'LINK_OAUTH_CLIENT_SECRET'],
    });
  });

  it('keeps payment off unless the flag is exactly true', () => {
    expect(browserUseSignupPaymentEnabled({})).toBe(false);
    expect(browserUseSignupPaymentEnabled({ BROWSER_USE_SIGNUP_PAYMENT_ENABLED: 'TRUE' })).toBe(
      false,
    );
    expect(browserUseSignupPaymentEnabled({ BROWSER_USE_SIGNUP_PAYMENT_ENABLED: 'true' })).toBe(
      true,
    );
  });
});
