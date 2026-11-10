import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureSafeException,
  exceptionProperties,
  redactedError,
  surfaceForRoute,
} from './exceptions';
import { resetPosthogClientsForTests } from './posthog-node';
import { decodeBatch } from './posthog-wire.testkit';

const SECRET = 'leak-marker-5d21';

function poisoned(): Error {
  const err = new TypeError(`could not send to ${SECRET}\nsecond line ${SECRET}`);
  return err;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetPosthogClientsForTests();
});

describe('redaction', () => {
  it('keeps the class and the frames, drops the message', () => {
    const safe = redactedError(poisoned());
    expect(safe.name).toBe('TypeError');
    expect(safe.message).toBe('redacted');
    expect(safe.stack).not.toContain(SECRET);
    expect(safe.stack).toMatch(/^TypeError: redacted\n\s+at /);
  });

  it('sends only the closed allowlist of properties', () => {
    const err = Object.assign(poisoned(), { code: 'ECONNRESET' });
    const props = exceptionProperties(err, {
      hale_surface: 'cron',
      route: '/api/cron/drain',
      method: 'GET',
    });
    expect(props).toEqual({
      hale_surface: 'cron',
      error_class: 'TypeError',
      code: 'ECONNRESET',
      route: '/api/cron/drain',
      method: 'GET',
    });
  });

  it('a free string in a context field ships as unclassified', () => {
    const props = exceptionProperties(new Error('x'), {
      hale_surface: 'api',
      stage: `Maya said ${SECRET}`,
    });
    expect(props.stage).toBe('unclassified');
  });

  it('classifies route patterns by surface', () => {
    expect(surfaceForRoute('/api/cron/drain')).toBe('cron');
    expect(surfaceForRoute('/api/webhooks/[provider]')).toBe('webhook');
    expect(surfaceForRoute('/api/rights/export')).toBe('api');
  });
});

describe('captureSafeException', () => {
  it('is a named no-op without POSTHOG_PROJECT_API_KEY — nothing leaves', async () => {
    vi.stubEnv('POSTHOG_PROJECT_API_KEY', '');
    resetPosthogClientsForTests();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(captureSafeException(poisoned(), 'system', { hale_surface: 'api' })).resolves.toBe(
      'not_configured',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with a key, the wire carries the class and not the message', async () => {
    vi.stubEnv('POSTHOG_PROJECT_API_KEY', 'phc_project_test');
    vi.stubEnv('POSTHOG_HOST', 'https://ph.example.com');
    resetPosthogClientsForTests();
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response('{}', { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      captureSafeException(poisoned(), 'system', { hale_surface: 'webhook' }),
    ).resolves.toBe('sent');
    expect(fetchMock).toHaveBeenCalled();
    const { text, events } = decodeBatch(fetchMock.mock.calls[0]?.[1]);
    expect(events[0]?.event).toBe('$exception');
    expect(text).toContain('TypeError');
    expect(text).not.toContain(SECRET);
    // Frames for source maps, but no source context lines around them.
    const list = events[0]?.properties.$exception_list as {
      value: string;
      stacktrace: { frames: Record<string, unknown>[] };
    }[];
    expect(list[0]?.value).toBe('redacted');
    expect(list[0]?.stacktrace.frames.length).toBeGreaterThan(0);
    expect(text).not.toContain('context_line');
  });
});
