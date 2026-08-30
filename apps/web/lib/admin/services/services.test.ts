import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchLangfuseDaily } from './langfuse';
import { fetchReplays, fetchSiteFunnel } from './posthog';
import { fetchTwilioAlerts, scrubDigits } from './twilio';

/**
 * Rule #11 across all three service clients: a missing credential and a dead
 * provider are NAMED outcomes, and the happy path parses without ever letting
 * a raw digit run (a phone number) through.
 */

const ENV_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_API_KEY_SID',
  'TWILIO_API_KEY_SECRET',
  'POSTHOG_PERSONAL_API_KEY',
  'POSTHOG_PROJECT_ID',
  'LANGFUSE_PUBLIC_KEY',
  'LANGFUSE_SECRET_KEY',
  'LANGFUSE_HOST',
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const neverFetch = vi.fn(async () => {
  throw new Error('fetch must not run without credentials');
}) as unknown as typeof fetch;

describe('fetchTwilioAlerts', () => {
  it('names the missing credential without touching the network', async () => {
    expect(await fetchTwilioAlerts(neverFetch)).toEqual({
      ok: false,
      status: 'not_configured',
      detail: expect.stringContaining('TWILIO'),
    });
    expect(neverFetch).not.toHaveBeenCalled();
  });

  it('parses alerts and SCRUBS digit runs from the summary', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        alerts: [
          {
            date_created: '2026-08-29T12:00:00Z',
            error_code: 11200,
            alert_text: 'HTTP retrieval failure for +14165551234',
          },
        ],
      }),
    ) as unknown as typeof fetch;
    const out = await fetchTwilioAlerts(fetchImpl);
    expect(out).toEqual({
      ok: true,
      data: [
        {
          at: '2026-08-29T12:00:00Z',
          source: 'twilio',
          code: '11200',
          summary: 'HTTP retrieval failure for +[digits]',
        },
      ],
    });
  });

  it('names a refusing provider as unreachable, never a throw', async () => {
    process.env.TWILIO_ACCOUNT_SID = 'AC123';
    process.env.TWILIO_AUTH_TOKEN = 'token';
    const refusing = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof fetch;
    expect(await fetchTwilioAlerts(refusing)).toEqual({
      ok: false,
      status: 'unreachable',
      detail: 'Twilio answered 503',
    });

    const dead = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchTwilioAlerts(dead)).toMatchObject({ ok: false, status: 'unreachable' });
  });
});

describe('scrubDigits', () => {
  it('replaces 7+ digit runs and leaves short counts alone', () => {
    expect(scrubDigits('code 11200 for 4165551234')).toBe('code 11200 for [digits]');
  });
});

describe('fetchSiteFunnel / fetchReplays', () => {
  it('name the missing key without touching the network', async () => {
    expect(await fetchSiteFunnel(neverFetch)).toMatchObject({ ok: false, status: 'not_configured' });
    expect(await fetchReplays(neverFetch)).toMatchObject({ ok: false, status: 'not_configured' });
  });

  it('parses the three funnel stages from the HogQL row', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'phx_test';
    process.env.POSTHOG_PROJECT_ID = '486181';
    const fetchImpl = vi.fn(async () => jsonResponse({ results: [[120, 30, 12]] })) as unknown as typeof fetch;
    const out = await fetchSiteFunnel(fetchImpl);
    expect(out).toEqual({
      ok: true,
      data: [
        { label: 'site views', count: 120 },
        { label: 'tapped "text Hale"', count: 30 },
        { label: 'reached text entry', count: 12 },
      ],
    });
  });

  it('parses replay rows with deep-linkable ids', async () => {
    process.env.POSTHOG_PERSONAL_API_KEY = 'phx_test';
    process.env.POSTHOG_PROJECT_ID = '486181';
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        results: [
          {
            id: 'rec-1',
            start_time: '2026-08-29T10:00:00Z',
            recording_duration: 42,
            start_url: 'https://villagehale.com/',
            click_count: 7,
          },
        ],
      }),
    ) as unknown as typeof fetch;
    expect(await fetchReplays(fetchImpl)).toEqual({
      ok: true,
      data: [
        {
          id: 'rec-1',
          startedAt: '2026-08-29T10:00:00Z',
          durationSeconds: 42,
          startUrl: 'https://villagehale.com/',
          clickCount: 7,
        },
      ],
    });
  });
});

describe('fetchLangfuseDaily', () => {
  it('names the missing keys without touching the network', async () => {
    expect(await fetchLangfuseDaily(neverFetch)).toMatchObject({
      ok: false,
      status: 'not_configured',
    });
  });

  it('parses daily trace counts + cost', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk';
    process.env.LANGFUSE_SECRET_KEY = 'sk';
    process.env.LANGFUSE_HOST = 'https://cloud.langfuse.com';
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ data: [{ date: '2026-08-29', countTraces: 44, totalCost: 1.25 }] }),
    ) as unknown as typeof fetch;
    expect(await fetchLangfuseDaily(fetchImpl)).toEqual({
      ok: true,
      data: [{ day: '2026-08-29', traces: 44, costUsd: 1.25 }],
    });
  });

  it('names a dead host as unreachable', async () => {
    process.env.LANGFUSE_PUBLIC_KEY = 'pk';
    process.env.LANGFUSE_SECRET_KEY = 'sk';
    process.env.LANGFUSE_HOST = 'https://cloud.langfuse.com';
    const dead = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await fetchLangfuseDaily(dead)).toMatchObject({ ok: false, status: 'unreachable' });
  });
});
