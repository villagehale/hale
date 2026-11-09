// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONSENT_STORAGE_KEY } from '~/lib/site/consent';

/**
 * VIL-483: the public landing page is the ONE place Hale records a session, and
 * only after cookie consent, with inputs masked. The portal side, where nothing
 * records, is apps/web/lib/analytics/posthog-replay.test.ts.
 *
 * Each case boots the REAL posthog-js through the real PostHogProvider on the
 * landing path, against a PostHog server whose remote config asks for recording.
 * posthog-js starts a recording by injecting `/static/lazy-recorder.js`, the same
 * request a browser shows in its network tab.
 */

const KEY_ENV = 'NEXT_PUBLIC_POSTHOG_KEY';
const HOST_ENV = 'NEXT_PUBLIC_POSTHOG_HOST';
const API_HOST = 'https://ph.test';
const LANDING = '/en';

// posthog-js captures `fetch` when it is first imported, so the server is stubbed once
// for the file and each case only resets the request log.
const requests: string[] = [];

interface Boot {
  posthogRequests: number;
  recorderRequested: boolean;
  recordingStatus: string | undefined;
  maskAllInputs: unknown;
  persistence: unknown;
}

async function bootLanding(): Promise<Boot> {
  window.history.replaceState(null, '', LANDING);
  requests.length = 0;
  process.env[KEY_ENV] = 'phc_test_key';
  process.env[HOST_ENV] = API_HOST;
  const { PostHogProvider } = await import('./posthog-provider');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const props = { locale: 'en' } as Parameters<typeof PostHogProvider>[0];
  await act(async () => {
    root.render(createElement(PostHogProvider, props, createElement('main', null, 'landing')));
  });
  for (let i = 0; i < 50 && !requests.some((u) => u.includes('/flags')); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 200));
  const { default: posthog } = await import('posthog-js');
  const boot: Boot = {
    posthogRequests: requests.length,
    recorderRequested: [...document.querySelectorAll('script')].some((s) =>
      s.src.includes('recorder'),
    ),
    recordingStatus: (posthog as unknown as { sessionRecording?: { status?: string } })
      .sessionRecording?.status,
    maskAllInputs: posthog.config.session_recording?.maskAllInputs,
    persistence: posthog.config.persistence,
  };
  await act(async () => root.unmount());
  return boot;
}

describe('the landing page records, masked, after consent (VIL-483)', () => {
  const originalKey = process.env[KEY_ENV];
  const originalHost = process.env[HOST_ENV];

  beforeAll(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        requests.push(url);
        const body =
          url.includes('/flags') || url.includes('/config')
            ? { sessionRecording: { endpoint: '/s/' }, featureFlags: {}, supportedCompression: [] }
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
    // posthog-js is an external dependency, so resetModules does not reset its
    // default singleton. Each case gets a fresh instance of the real client class.
    vi.doMock('posthog-js', async () => {
      const actual = await vi.importActual<typeof import('posthog-js')>('posthog-js');
      return { ...actual, default: new actual.PostHog() };
    });
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    window.localStorage.clear();
    window.sessionStorage.clear();
    // posthog-js keeps its lazy loaders and remote config on window, which outlive
    // vi.resetModules; a stale copy would make the next fresh client skip its boot.
    const w = window as unknown as Record<string, unknown>;
    for (const name of ['__PosthogExtensions__', '_POSTHOG_REMOTE_CONFIG', 'posthog']) {
      delete w[name];
    }
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = originalKey;
    if (originalHost === undefined) delete process.env[HOST_ENV];
    else process.env[HOST_ENV] = originalHost;
  });

  it('starts the recorder once the visitor has accepted, with inputs masked', async () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'granted');
    const boot = await bootLanding();
    expect(boot.recorderRequested).toBe(true);
    expect(boot.recordingStatus).not.toBe('disabled');
    expect(boot.maskAllInputs).toBe(true);
    expect(boot.persistence).toBe('memory');
  });

  it('loads nothing, recorder included, before the visitor has chosen', async () => {
    const boot = await bootLanding();
    expect(boot.posthogRequests).toBe(0);
    expect(boot.recorderRequested).toBe(false);
  });

  it('loads nothing after the visitor taps No thanks', async () => {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, 'denied');
    const boot = await bootLanding();
    expect(boot.posthogRequests).toBe(0);
    expect(boot.recorderRequested).toBe(false);
  });
});
