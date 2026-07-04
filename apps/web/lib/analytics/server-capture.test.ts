import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { captureServerEvent } from './server-capture';

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

  it('no-ops (no fetch) when no PostHog key is configured', async () => {
    vi.stubEnv('NEXT_PUBLIC_POSTHOG_KEY', '');
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await captureServerEvent('signup_completed', DISTINCT_ID, { method: 'email' });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
