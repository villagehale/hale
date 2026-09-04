import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureInboundRouted,
  captureServerEvent,
  resetAnalyticsAbsenceLogForTests,
} from './server-capture';

// Server-side analytics capture: a dependency-free POST to PostHog's capture
// endpoint, used where no client hook exists (server actions). Every payload goes
// through the SAME buildEvent redaction chokepoint as the client, so identifying or
// non-primitive properties can never leave (rule #1). No-ops without a key.

const DISTINCT_ID = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', 'phc_test');
  vi.stubEnv('NEXT_PUBLIC_POSTHOG_HOST', 'https://ph.example.com');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('captureServerEvent', () => {
  it('posts the sanitized event to the capture endpoint with the key and distinct_id', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await captureServerEvent('signup_completed', DISTINCT_ID, { method: 'email' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0];
    const init = fetchMock.mock.calls[0]?.[1];
    expect(url).toBe('https://ph.example.com/i/v0/e/');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)) as {
      api_key: string;
      event: string;
      distinct_id: string;
      properties: Record<string, unknown>;
    };
    expect(body.api_key).toBe('phc_test');
    expect(body.event).toBe('signup_completed');
    expect(body.distinct_id).toBe(DISTINCT_ID);
    expect(body.properties).toEqual({ method: 'email' });
  });

  it('strips identifying properties through buildEvent before sending', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await captureServerEvent('signup_completed', DISTINCT_ID, {
      method: 'email',
      email: 'leak@example.com',
    });

    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as { properties: Record<string, unknown> };
    // The forbidden 'email' key is dropped; the coarse 'method' survives.
    expect(body.properties).toEqual({ method: 'email' });
  });

  it('names the missing key, logs it once, and never throws (rule #11)', async () => {
    // A dead key must not become a silent success and must not block a send. It is a
    // NAMED outcome, and the warning is once per process — a cron sweep with a dead key
    // would otherwise write a line per family.
    resetAnalyticsAbsenceLogForTests();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = await captureServerEvent('signup_completed', DISTINCT_ID, { method: 'email' });
    const second = await captureServerEvent('loop_plan_sent', DISTINCT_ID);

    expect(first).toBe('not_configured');
    expect(second).toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports a real send as sent, so a caller can tell the two apart', async () => {
    resetAnalyticsAbsenceLogForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 200 })),
    );
    await expect(captureServerEvent('signup_completed', DISTINCT_ID)).resolves.toBe('sent');
  });
});

describe('captureInboundRouted', () => {
  it('posts door + outcome only, keyed on the door — never a person, bounded by a timeout', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(captureInboundRouted('sms', 'rate_limited')).resolves.toBe('sent');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as {
      event: string;
      distinct_id: string;
      properties: Record<string, unknown>;
    };
    expect(body.event).toBe('inbound_routed');
    expect(body.distinct_id).toBe('door:sms');
    expect(body.properties).toEqual({ door: 'sms', outcome: 'rate_limited' });
    // The webhook's 15s budget cannot be spent waiting on PostHog.
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('ships `unclassified` for a non-enum outcome — a free string can never ride the counter', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await captureInboundRouted('email', 'Maya said hi');

    const init = fetchMock.mock.calls[0]?.[1];
    const body = JSON.parse(String(init?.body)) as { properties: Record<string, unknown> };
    expect(body.properties).toEqual({ door: 'email', outcome: 'unclassified' });
  });

  it('never throws — a hung or refused counter is a named provider_error, not a webhook 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('posthog down');
      }),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(captureInboundRouted('sms', 'handed_off')).resolves.toBe('provider_error');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is a named not_configured without a key, and sends nothing', async () => {
    resetAnalyticsAbsenceLogForTests();
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(captureInboundRouted('email', 'unknown_sender')).resolves.toBe('not_configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
