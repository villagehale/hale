import { describe, expect, it, vi } from 'vitest';
import type { SignupIdentity } from '../types';
import { browserUseApi } from './client';
import { type BrowserUseEngineDeps, runBrowserUseSignup } from './engine';
import { browserUseSignupPaymentEnabled } from './flag';
import { signupWalletFromEnv } from './runner';
import { LINK_APPROVAL_WINDOW_MINUTES, browserUseStripeLinkWallet } from './wallet';

// Mocked Browser Use responses only. No Stripe Link or Browser Use call leaves the process.
const NOW = new Date('2026-10-21T15:00:00.000Z');
const URL_ = 'https://register.example-rec.test/swim/123';
const LIVE = 'https://live.browser-use.com/s/fixture-live-view-token';
const WALLET = {
  kind: 'stripe_link' as const,
  connectionId: 'link-conn-fixture',
  approvalWindowMinutes: 5,
};
const IDENTITY: SignupIdentity = {
  childFirstName: 'Ada',
  childLastName: 'Lovelace',
  childDob: '2022-04-01',
  parentFirstName: 'Grace',
  parentEmail: 'grace@example.test',
  postalCode: 'M5V2T6',
  teenager: false,
};

const BASE_OUTPUT = {
  outcome: 'reached_checkout',
  detail: 'none',
  checkout_url: 'https://register.example-rec.test/checkout',
  cart_total_cents: 9800,
  hold_minutes: 8,
  payment_details_entered: false,
  opens_at: null,
  confirmation_number: null,
  amount_charged_cents: null,
};

function engine(output: Record<string, unknown>) {
  const bodies: { method: string; path: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname.replace('/api/v4', '');
    const method = init.method ?? 'GET';
    bodies.push({
      method,
      path,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    if (method === 'POST' && path === '/runs') {
      return Response.json({ id: 'run-1', sessionId: 'bu-session-1' });
    }
    if (path === '/runs/run-1/status') return Response.json({ status: 'completed' });
    if (path === '/runs/run-1/events') {
      return Response.json({
        events: [{ id: 1, type: 'browser.ready', data: { live_view_url: LIVE } }],
      });
    }
    if (path === '/runs/run-1') {
      return Response.json({
        id: 'run-1',
        status: 'completed',
        sessionId: 'bu-session-1',
        output: { ...BASE_OUTPUT, ...output },
        error: null,
        totalCostUsd: '0.03',
      });
    }
    throw new Error(`unexpected ${method} ${path}`);
  });
  const deps: BrowserUseEngineDeps = {
    api: browserUseApi({ apiKey: 'test-key', fetch: fetchImpl }),
    seeder: null,
    loadTask: async () => '# skill',
    sleep: async () => undefined,
    now: () => NOW,
  };
  return { deps, bodies };
}

function input(payment: typeof WALLET | null) {
  return {
    correlationId: 'offer-fixture',
    registrationUrl: URL_,
    identity: IDENTITY,
    fieldsAllowed: ['child_first_name', 'session'] as const,
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
            sameSite: 'Lax' as const,
          },
        ],
        origins: [],
      },
      browserUseProfileId: 'profile-existing',
    },
    onProfileCreated: async () => undefined,
  };
}

function runBody(bodies: { method: string; path: string; body: unknown }[]) {
  return bodies.find((entry) => entry.method === 'POST' && entry.path === '/runs')?.body as Record<
    string,
    unknown
  >;
}

describe('stripe link payment', () => {
  it('pays the exact total with the Link wallet and returns the confirmation', async () => {
    const { deps, bodies } = engine({
      outcome: 'completed',
      payment_details_entered: true,
      amount_charged_cents: 9800,
      confirmation_number: 'R-55120',
    });
    const result = await runBrowserUseSignup(input(WALLET), deps);
    expect(result).toMatchObject({
      outcome: 'completed',
      confirmationNumber: 'R-55120',
      amountChargedCents: 9800,
      cartTotalCents: 9800,
      liveViewUrl: null,
    });
    const body = runBody(bodies);
    expect(body.stripeLinkConnectionId).toBe('link-conn-fixture');
    expect(String(body.task)).toMatch(/"max_total_cents":\s*9800/);
    expect(String(body.task)).not.toMatch(/\b4242\b|card_number|cvc/i);
  });

  it('sends no Link connection and treats a payment as a boundary breach without a wallet', async () => {
    const { deps, bodies } = engine({
      outcome: 'completed',
      payment_details_entered: true,
      amount_charged_cents: 9800,
    });
    const result = await runBrowserUseSignup(input(null), deps);
    expect(result).toMatchObject({ outcome: 'error', detail: 'payment_boundary' });
    expect(runBody(bodies)).not.toHaveProperty('stripeLinkConnectionId');
    expect(String(runBody(bodies).task)).toMatch(/"payment":\s*null/);
  });

  it('hands to the parent when the charge is not the exact cart total', async () => {
    const { deps } = engine({ outcome: 'completed', amount_charged_cents: 9900 });
    const result = await runBrowserUseSignup(input(WALLET), deps);
    expect(result).toMatchObject({
      outcome: 'needs_human',
      detail: 'charge_mismatch',
      liveViewUrl: LIVE,
      amountChargedCents: 9900,
    });
  });

  it('returns the live checkout link when the parent does not approve in time', async () => {
    const { deps } = engine({ outcome: 'payment_not_approved' });
    const result = await runBrowserUseSignup(input(WALLET), deps);
    expect(result).toMatchObject({
      outcome: 'payment_not_approved',
      liveViewUrl: LIVE,
      checkoutUrl: 'https://register.example-rec.test/checkout',
      confirmationNumber: null,
    });
    expect(result.holdExpiresAt?.toISOString()).toBe('2026-10-21T15:08:00.000Z');
  });

  it('returns a rush with the open time the page states', async () => {
    const { deps } = engine({
      outcome: 'rush',
      detail: 'timed_open',
      checkout_url: null,
      cart_total_cents: null,
      opens_at: 'Monday, January 5 at 7:00 AM',
    });
    const result = await runBrowserUseSignup(input(WALLET), deps);
    expect(result).toMatchObject({
      outcome: 'rush',
      detail: 'timed_open',
      opensAt: 'Monday, January 5 at 7:00 AM',
      liveViewUrl: null,
    });
  });
});

describe('stripe link wallet source', () => {
  function linkApi(body: unknown) {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(new URL(url).pathname).toBe('/api/v4/stripe-link');
      return Response.json(body);
    });
    return { api: browserUseApi({ apiKey: 'test-key', fetch: fetchImpl }), fetchImpl };
  }

  it('resolves the connected Link wallet with the approval window', async () => {
    const { api } = linkApi({
      isConnected: true,
      connectionId: 'link-conn-fixture',
      linkEmail: 'grace@example.test',
      mode: 'test',
    });
    const lookup = await browserUseStripeLinkWallet(api).forFamily('family-1');
    expect(lookup).toEqual({
      wallet: {
        kind: 'stripe_link',
        connectionId: 'link-conn-fixture',
        approvalWindowMinutes: LINK_APPROVAL_WINDOW_MINUTES,
      },
      skipped: null,
    });
    expect(JSON.stringify(lookup)).not.toContain('grace@');
  });

  it('names a missing Link connection', async () => {
    const { api } = linkApi({ isConnected: false, connectionId: null, mode: null });
    expect(await browserUseStripeLinkWallet(api).forFamily('family-1')).toEqual({
      wallet: null,
      skipped: 'not_connected',
    });
  });

  it('names a missing key without calling out', () => {
    const fetchImpl = vi.fn();
    expect(signupWalletFromEnv({}, fetchImpl)).toEqual({ source: null, skipped: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
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
