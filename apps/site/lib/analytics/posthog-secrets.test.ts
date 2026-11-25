// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_STORAGE_KEY } from '~/lib/site/consent';

/**
 * The checkout success URL carries the Stripe Checkout Session id (`session_id`). A first
 * load stores the URL as the person's initial URL, which the flags request sends past
 * `before_send`, so PostHog does not load on a page whose query holds a secret, and
 * `before_send` rewrites any secret a later event still names. Boots the REAL posthog-js
 * through the real provider against a stubbed server, after cookie consent.
 */

const KEY_ENV = 'NEXT_PUBLIC_POSTHOG_KEY';
const HOST_ENV = 'NEXT_PUBLIC_POSTHOG_HOST';
const WEB_ENV = 'NEXT_PUBLIC_POSTHOG_WEB_ENABLED';
const SESSION = 'cs_live_SeSsIoN123';

const requests: string[] = [];

async function bootAt(path: string): Promise<void> {
  window.history.replaceState(null, '', path);
  requests.length = 0;
  vi.stubEnv(KEY_ENV, 'phc_test_key');
  vi.stubEnv(HOST_ENV, 'https://ph.test');
  vi.stubEnv(WEB_ENV, 'true');
  const { PostHogProvider } = await import('./posthog-provider');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const props = { locale: 'en' } as Parameters<typeof PostHogProvider>[0];
  await act(async () => {
    root.render(createElement(PostHogProvider, props, createElement('main', null, 'page')));
  });
  await new Promise((r) => setTimeout(r, 400));
  await act(async () => root.unmount());
}

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(`${String(input)}\n${typeof init?.body === 'string' ? init.body : ''}`);
      const url = String(input);
      const body =
        url.includes('/flags') || url.includes('/config')
          ? { featureFlags: {}, supportedCompression: [] }
          : { status: 1 };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.resetModules();
  vi.doMock('posthog-js', async () => {
    const actual = await vi.importActual<typeof import('posthog-js')>('posthog-js');
    return { ...actual, default: new actual.PostHog() };
  });
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  window.localStorage.clear();
  window.sessionStorage.clear();
  const w = window as unknown as Record<string, unknown>;
  for (const name of ['__PosthogExtensions__', '_POSTHOG_REMOTE_CONFIG', 'posthog']) {
    delete w[name];
  }
  window.localStorage.setItem(CONSENT_STORAGE_KEY, 'granted');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('a secret in the URL never reaches PostHog on the marketing site', () => {
  it('PostHog does not load on the checkout success page with its session id', async () => {
    await bootAt(`/checkout/success?session_id=${SESSION}`);
    expect(requests).toEqual([]);

    // Positive control: the same provider, after the same consent, loads on the landing page.
    await bootAt('/en');
    expect(requests.some((r) => r.includes('/flags') || r.includes('/config'))).toBe(true);
  });

  it('rewrites a secret in every string and key of a later event', async () => {
    const { redactSecretEvent } = await import('./url-secrets');
    const out = redactSecretEvent({
      uuid: 'u',
      event: '$pageview',
      properties: {
        $current_url: `https://villagehale.com/checkout/success?session_id=${SESSION}&x=1`,
        $referrer: `https://app.villagehale.com/connect?t=${SESSION}`,
        encoded: `%3Fsession_id%3D${SESSION}`,
        source: 'https://villagehale.com/?source_code=ig1&type=card',
      },
      $set_once: { $initial_current_url: `/checkout/success?session_id=${SESSION}` },
    });
    expect(JSON.stringify(out)).not.toContain(SESSION);
    expect(out?.properties).toEqual({
      $current_url: 'https://villagehale.com/checkout/success?session_id=[redacted]&x=1',
      $referrer: 'https://app.villagehale.com/connect?t=[redacted]',
      encoded: '%3Fsession_id%3D[redacted]',
      source: 'https://villagehale.com/?source_code=ig1&type=card',
    });
    expect(out?.$set_once).toEqual({ $initial_current_url: '/checkout/success?session_id=[redacted]' });
    expect(redactSecretEvent(null)).toBeNull();
  });
});
