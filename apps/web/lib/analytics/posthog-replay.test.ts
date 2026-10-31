// @vitest-environment happy-dom
import { createElement } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VIL-483: no portal page records a session. Only the marketing landing page may
 * (apps/site/lib/analytics/posthog-replay.test.ts holds that side).
 *
 * Each case boots the REAL posthog-js through the real PostHogProvider, on a real
 * portal path, against a PostHog server whose remote config ASKS for recording
 * (the project-level "record user sessions" switch). posthog-js starts a recording
 * by injecting `/static/lazy-recorder.js`, which is the request a browser shows in
 * its network tab. A portal page must never inject it, whatever the server says.
 *
 * The positive control proves the harness can see a recording start, so the
 * absence assertions are not vacuous.
 */

const KEY_ENV = 'NEXT_PUBLIC_POSTHOG_KEY';
const HOST_ENV = 'NEXT_PUBLIC_POSTHOG_HOST';
const API_HOST = 'https://ph.test';

const PORTAL_ROUTES = [
  '/connect',
  '/connected',
  '/rsvp/tok_example',
  '/invite/tok_example',
  '/settings/privacy',
  '/demo/passport',
  '/family',
  '/family/child_example',
  '/sign-in',
  '/verify',
  '/magic-link',
  '/m/magic',
  '/home',
];

interface Boot {
  remoteConfigFetched: boolean;
  recorderRequested: boolean;
  recordingStatus: string | undefined;
  disableSessionRecording: unknown;
}

// posthog-js captures `fetch` when it is first imported, so the server is stubbed once
// for the file and each case only resets the request log.
const requests: string[] = [];
const server = { remoteConfigFetched: () => requests.some((u) => u.includes('/flags')) };

function stubPostHogServer(): typeof server {
  requests.length = 0;
  return server;
}

function recorderRequested(): boolean {
  return [...document.querySelectorAll('script')].some((s) => s.src.includes('recorder'));
}

async function settle(server: { remoteConfigFetched: () => boolean }): Promise<void> {
  for (let i = 0; i < 50 && !server.remoteConfigFetched(); i++) {
    await new Promise((r) => setTimeout(r, 20));
  }
  // The recorder is injected in the same turn the remote config is applied; give it
  // a margin so a late injection would still be seen.
  await new Promise((r) => setTimeout(r, 200));
}

async function snapshot(server: { remoteConfigFetched: () => boolean }): Promise<Boot> {
  await settle(server);
  const { default: posthog } = await import('posthog-js');
  return {
    remoteConfigFetched: server.remoteConfigFetched(),
    recorderRequested: recorderRequested(),
    recordingStatus: (posthog as unknown as { sessionRecording?: { status?: string } })
      .sessionRecording?.status,
    disableSessionRecording: posthog.config.disable_session_recording,
  };
}

async function bootPortalRoute(path: string): Promise<Boot> {
  window.history.replaceState(null, '', path);
  const server = stubPostHogServer();
  process.env[KEY_ENV] = 'phc_test_key';
  process.env[HOST_ENV] = API_HOST;
  const { PostHogProvider } = await import('./posthog-provider');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PostHogProvider, null, createElement('main', null, 'portal')));
  });
  const boot = await snapshot(server);
  await act(async () => root.unmount());
  return boot;
}

describe('portal pages start no session recording (VIL-483)', () => {
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
    // default singleton: once one case inits it, the provider sees `__loaded` and
    // skips init. Each case gets a fresh instance of the real client class instead.
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
    for (const c of document.cookie.split(';')) {
      document.cookie = `${c.split('=')[0]}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    }
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env[KEY_ENV];
    else process.env[KEY_ENV] = originalKey;
    if (originalHost === undefined) delete process.env[HOST_ENV];
    else process.env[HOST_ENV] = originalHost;
  });

  it('positive control: the same server config DOES start a recorder when replay is allowed', async () => {
    window.history.replaceState(null, '', '/home');
    const server = stubPostHogServer();
    const { POSTHOG_INIT_CONFIG } = await import('./posthog-provider');
    const { default: posthog } = await import('posthog-js');
    posthog.init('phc_test_key', {
      api_host: API_HOST,
      ...POSTHOG_INIT_CONFIG,
      disable_session_recording: false,
    });
    const boot = await snapshot(server);
    expect(boot.remoteConfigFetched).toBe(true);
    expect(boot.recorderRequested).toBe(true);
    expect(boot.recordingStatus).not.toBe('disabled');
  });

  it.each(PORTAL_ROUTES)('%s: analytics loads but the recorder never does', async (path) => {
    const boot = await bootPortalRoute(path);
    // Analytics still runs (the remote config was fetched), so this is not a page
    // where PostHog simply never loaded.
    expect(boot.remoteConfigFetched).toBe(true);
    expect(boot.recorderRequested).toBe(false);
    expect(boot.recordingStatus).toBe('disabled');
    expect(boot.disableSessionRecording).toBe(true);
  });
});
