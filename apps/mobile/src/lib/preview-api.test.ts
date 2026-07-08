import { afterEach, describe, expect, it, vi } from 'vitest';

import { areaCoarseFromLocation, fetchPreview } from './preview-api';

/**
 * The pre-auth anonymous preview call. It POSTs a COARSE, identity-free body
 * ({stage, areaCoarse, interests}) to /api/preview and must NEVER block or fake the
 * onboarding flow: any non-200, network error, timeout, or malformed body resolves
 * to an empty list so the screen can skip the teaser gracefully (never invent
 * results — rule #8). Expectations are derived from that contract, not the
 * implementation. `fetch` is faked (the module under test only orchestrates the
 * request), which is a network boundary, not the LLM — hard rule #8's no-LLM-mock
 * rule is about agent tests, and this is the client caller.
 */

const okResponse = (body: unknown): Response =>
  ({ ok: true, json: async () => body }) as unknown as Response;

const base = 'https://app.villagehale.com';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('areaCoarseFromLocation', () => {
  it('prefers the city when present', () => {
    expect(areaCoarseFromLocation({ city: 'Toronto', postalCode: 'M5V 2T6' })).toBe('Toronto');
  });

  it('falls back to the postal FSA (first three chars) when there is no city', () => {
    // Coarse only (rule #1): the forward sortation area, never the full code.
    expect(areaCoarseFromLocation({ postalCode: 'M5V 2T6' })).toBe('M5V');
  });

  it('returns null when neither a city nor a postal code is set', () => {
    expect(areaCoarseFromLocation({})).toBeNull();
    expect(areaCoarseFromLocation({ city: '  ', postalCode: '' })).toBeNull();
  });
});

describe('fetchPreview', () => {
  it('POSTs the coarse body to /api/preview and returns the activities on success', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit): Promise<Response> =>
        okResponse({ activities: [{ title: 'Baby & me swim', summary: 's', coverageNote: 'c' }] }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchPreview(
      { stage: 'newborn', areaCoarse: 'Toronto', interests: ['activities'] },
      'https://app.villagehale.com',
    );

    expect(result).toEqual([{ title: 'Baby & me swim', summary: 's', coverageNote: 'c' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://app.villagehale.com/api/preview');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      stage: 'newborn',
      areaCoarse: 'Toronto',
      interests: ['activities'],
    });
  });

  it('resolves to an empty list on a non-200 (never blocks the flow)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false }) as Response));
    expect(
      await fetchPreview({ stage: 'toddler', areaCoarse: 'Toronto', interests: [] }, base),
    ).toEqual([]);
  });

  it('resolves to an empty list when fetch throws (offline / timeout / abort)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );
    expect(
      await fetchPreview({ stage: 'child', areaCoarse: 'Toronto', interests: [] }, base),
    ).toEqual([]);
  });

  it('resolves to an empty list when the body has no activities array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okResponse({ nope: true })));
    expect(
      await fetchPreview({ stage: 'child', areaCoarse: 'Toronto', interests: [] }, base),
    ).toEqual([]);
  });

  it('resolves to an empty list when the API base is not configured', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(
      await fetchPreview({ stage: 'child', areaCoarse: 'Toronto', interests: [] }, undefined),
    ).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
