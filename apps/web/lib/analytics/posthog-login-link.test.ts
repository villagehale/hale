// @vitest-environment happy-dom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * /l/<code> is a bearer link: whoever holds the code can save a login for the family.
 * The code must never reach PostHog. Each case boots the REAL posthog-js against a
 * stubbed PostHog server and reads every request that left, decoded (the flags request
 * carries the person's initial URL base64-encoded, past before_send).
 *
 * happy-dom's user agent reads as a bot to posthog-js, which then drops events before
 * they are sent; the cases that need events turn that filter off. Nothing else differs
 * from the shipped config.
 */

const CODE = 'AbCdEf1234';
const API_HOST = 'https://ph.test';
const KEY_ENV = 'NEXT_PUBLIC_POSTHOG_KEY';
const HOST_ENV = 'NEXT_PUBLIC_POSTHOG_HOST';
const WEB_ENV = 'NEXT_PUBLIC_POSTHOG_WEB_ENABLED';

const sent: string[] = [];

function decoded(url: string, body: BodyInit | null | undefined): string {
  const text = typeof body === 'string' ? body : '';
  const data = text.startsWith('data=')
    ? Buffer.from(decodeURIComponent(text.slice('data='.length)), 'base64').toString('utf8')
    : text;
  return `${url}\n${data}`;
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
}

beforeAll(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push(decoded(url, init?.body));
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
  sent.length = 0;
  vi.resetModules();
  // A fresh client per case: the posthog-js default singleton outlives resetModules.
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
  // A client wraps history.pushState once and marks it; a later client skips a marked
  // method, so each case starts from the unwrapped one.
  for (const method of ['pushState', 'replaceState']) {
    if (Object.hasOwn(window.history, method)) {
      delete (window.history as unknown as Record<string, unknown>)[method];
    }
  }
  for (const c of document.cookie.split(';')) {
    document.cookie = `${c.split('=')[0]}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
  vi.stubEnv(KEY_ENV, 'phc_test_key');
  vi.stubEnv(HOST_ENV, API_HOST);
  vi.stubEnv(WEB_ENV, 'true');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function initDirect(overrides: Record<string, unknown> = {}) {
  const { POSTHOG_INIT_CONFIG } = await import('./posthog-provider');
  const { default: posthog } = await import('posthog-js');
  posthog.init('phc_test_key', {
    api_host: API_HOST,
    ...POSTHOG_INIT_CONFIG,
    request_batching: false,
    opt_out_useragent_filter: true,
    ...overrides,
  });
  return posthog;
}

async function mountProvider(path: string): Promise<void> {
  window.history.replaceState(null, '', path);
  const { PostHogProvider } = await import('./posthog-provider');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(PostHogProvider, null, createElement('main', null, 'page')));
  });
  await settle();
  await act(async () => root.unmount());
}

describe('the /l/<code> bearer code never reaches PostHog', () => {
  it('positive control: without the redaction, the code leaves in the event and the flags request', async () => {
    window.history.replaceState(null, '', `/l/${CODE}`);
    await initDirect({ before_send: undefined });
    await settle();
    expect(sent.some((r) => r.includes('/e/') && r.includes(CODE))).toBe(true);
    expect(sent.some((r) => r.includes('/flags') && r.includes(CODE))).toBe(true);
  });

  it('PostHog does not load on a /l/ page: no request leaves at all', async () => {
    await mountProvider(`/l/${CODE}`);
    expect(sent).toEqual([]);

    // Positive control: the same provider on another page does load.
    await mountProvider('/connect');
    expect(sent.some((r) => r.includes('/flags'))).toBe(true);
  });

  it('a /l/ visit inside a loaded app goes out as /l/[code], and nothing after it names the code', async () => {
    window.history.replaceState(null, '', '/connect');
    const posthog = await initDirect();
    await settle();
    window.history.pushState(null, '', `/l/${CODE}`);
    await settle();
    window.history.pushState(null, '', '/connect');
    posthog.capture('next_page_event');
    await settle();

    const events = sent.filter((r) => r.includes('/e/'));
    expect(events.some((r) => r.includes('"$current_url":"http://localhost:3000/l/[code]"'))).toBe(
      true,
    );
    expect(events.some((r) => r.includes('"event":"next_page_event"'))).toBe(true);
    expect(sent.join('\n')).not.toContain(CODE);
  });
});

describe('redactLoginLinkCodes', () => {
  it('rewrites the code in every string and key, including $set, $set_once and replay data', async () => {
    const { redactLoginLinkCodes } = await import('./posthog-provider');
    const out = redactLoginLinkCodes({
      uuid: 'u',
      event: '$snapshot',
      properties: {
        $current_url: `https://app.example.test/l/${CODE}?x=1`,
        $referrer: `https://app.example.test/l/${CODE}`,
        $heatmap_data: { [`https://app.example.test/l/${CODE}`]: [{ x: 1 }] },
        $snapshot_data: [
          { type: 4, data: { href: `https://app.example.test/l/${CODE}` } },
          { type: 6, data: { payload: { name: `https://app.example.test/api/signup/l/${CODE}` } } },
        ],
        next: `%2Fl%2F${CODE}`,
        count: 3,
      },
      $set: { $current_url: `/l/${CODE}` },
      $set_once: { $initial_current_url: `/l/${CODE}#top` },
    });
    const text = JSON.stringify(out);
    expect(text).not.toContain(CODE);
    expect(out?.properties).toEqual({
      $current_url: 'https://app.example.test/l/[code]?x=1',
      $referrer: 'https://app.example.test/l/[code]',
      $heatmap_data: { 'https://app.example.test/l/[code]': [{ x: 1 }] },
      $snapshot_data: [
        { type: 4, data: { href: 'https://app.example.test/l/[code]' } },
        { type: 6, data: { payload: { name: 'https://app.example.test/api/signup/l/[code]' } } },
      ],
      next: '%2Fl%2F[code]',
      count: 3,
    });
    expect(out?.$set).toEqual({ $current_url: '/l/[code]' });
    expect(out?.$set_once).toEqual({ $initial_current_url: '/l/[code]#top' });
    expect(redactLoginLinkCodes(null)).toBeNull();
  });
});
