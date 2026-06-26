import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type GeocodeClient,
  type LatLng,
  buildTextQuery,
  defaultGeocodeClient,
  geocodeArea,
  geocodeVenue,
} from './geocode.js';

/**
 * geocodeVenue resolves a candidate's venue to PUBLIC coordinates via an injected
 * Places client. We assert: a resolvable venue yields coords + venue name/address;
 * an unresolvable venue (empty places) yields null (list-only, no pin); a thrown
 * transport/quota error yields null and NEVER propagates (a best-effort enrichment
 * must not abort a discovery run); and the query sent to Places carries only the
 * COARSE area for disambiguation — never a precise address (rule #1).
 */

const AREA_COARSE = 'M4K';

/** A Places Text Search (New) response for one resolved public venue. */
const RESOLVED = {
  places: [
    {
      location: { latitude: 43.6777, longitude: -79.3534 },
      displayName: { text: 'Riverdale Library' },
      formattedAddress: '370 Broadview Ave, Toronto, ON',
      websiteUri: 'https://www.torontopubliclibrary.ca/riverdale',
    },
  ],
};

function fakeClient(impl: (q: string) => Promise<unknown>): {
  client: GeocodeClient;
  calls: string[];
  biasCalls: Array<LatLng | undefined>;
} {
  const calls: string[] = [];
  const biasCalls: Array<LatLng | undefined> = [];
  const client: GeocodeClient = {
    searchText: vi.fn(async (q: string, bias?: LatLng) => {
      calls.push(q);
      biasCalls.push(bias);
      return impl(q);
    }),
  };
  return { client, calls, biasCalls };
}

describe('buildTextQuery', () => {
  it('disambiguates with the COARSE area only — never a precise address (rule #1)', () => {
    const q = buildTextQuery('Riverdale Library kids storytime', AREA_COARSE);
    expect(q).toBe('Riverdale Library kids storytime M4K');
    // The finest grain in the query is the coarse area; no street/house number.
    expect(q).not.toMatch(/\d{2,5}\s+\w+\s+(st|street|ave|avenue|rd|road)/i);
  });
});

describe('geocodeVenue', () => {
  it('stores coords + venue name/address + the venue website for a resolvable venue', async () => {
    const { client, calls } = fakeClient(async () => RESOLVED);

    const result = await geocodeVenue('Riverdale Library kids storytime', AREA_COARSE, client);

    expect(result).toEqual({
      lat: 43.6777,
      lng: -79.3534,
      venueName: 'Riverdale Library',
      venueAddress: '370 Broadview Ave, Toronto, ON',
      website: 'https://www.torontopubliclibrary.ca/riverdale',
    });
    // Only the coarse area reaches Google — no precise location (rule #1).
    expect(calls).toEqual(['Riverdale Library kids storytime M4K']);
  });

  it('leaves website undefined when the venue has no websiteUri', async () => {
    const { client } = fakeClient(async () => ({
      places: [
        {
          location: { latitude: 43.6, longitude: -79.4 },
          displayName: { text: 'A park' },
          formattedAddress: '1 Park Lane, Toronto, ON',
        },
      ],
    }));
    const result = await geocodeVenue('a park', AREA_COARSE, client);
    expect(result?.website).toBeUndefined();
  });

  it('leaves coords null for an unresolvable venue (no pin, list-only)', async () => {
    const { client } = fakeClient(async () => ({ places: [] }));
    const result = await geocodeVenue('online newborn webinar', AREA_COARSE, client);
    expect(result).toBeNull();
  });

  it('leaves coords null when the response lacks a location (malformed place)', async () => {
    const { client } = fakeClient(async () => ({
      places: [{ displayName: { text: 'No coords place' } }],
    }));
    const result = await geocodeVenue('a place with no coords', AREA_COARSE, client);
    expect(result).toBeNull();
  });

  it('NEVER throws on a transport/quota error — returns null instead', async () => {
    const { client } = fakeClient(async () => {
      throw new Error('places searchText failed: 429');
    });
    await expect(geocodeVenue('any venue', AREA_COARSE, client)).resolves.toBeNull();
  });

  it('passes the COARSE-area centre to the Places client as the bias (rule #1)', async () => {
    const { client, biasCalls } = fakeClient(async () => RESOLVED);
    const bias = { lat: 43.6285, lng: -79.9618 }; // Halton Hills, not a precise home

    await geocodeVenue('Riverdale Library', AREA_COARSE, client, bias);

    // The bias is the coarse-area centre — never a precise home (rule #1).
    expect(biasCalls).toEqual([bias]);
  });

  it('omits the bias when none is supplied (text-only search preserved)', async () => {
    const { client, biasCalls } = fakeClient(async () => RESOLVED);

    await geocodeVenue('Riverdale Library', AREA_COARSE, client);

    expect(biasCalls).toEqual([undefined]);
  });
});

describe('geocodeArea', () => {
  it('returns the centre of a resolved coarse area', async () => {
    const { client, calls } = fakeClient(async () => ({
      places: [{ location: { latitude: 43.6285, longitude: -79.9618 } }],
    }));

    const center = await geocodeArea('Halton Hills', client);

    expect(center).toEqual({ lat: 43.6285, lng: -79.9618 });
    // Only the coarse area string reaches Places (rule #1).
    expect(calls).toEqual(['Halton Hills']);
  });

  it('returns null for an unresolvable area', async () => {
    const { client } = fakeClient(async () => ({ places: [] }));
    expect(await geocodeArea('Nowhere', client)).toBeNull();
  });

  it('returns null for a blank area without calling Places', async () => {
    const { client, calls } = fakeClient(async () => RESOLVED);
    expect(await geocodeArea('  ', client)).toBeNull();
    expect(calls).toEqual([]);
  });

  it('NEVER throws on a transport/quota error — returns null instead', async () => {
    const { client } = fakeClient(async () => {
      throw new Error('places searchText failed: 429');
    });
    await expect(geocodeArea('M4K', client)).resolves.toBeNull();
  });
});

describe('defaultGeocodeClient searchText request body', () => {
  const KEY = 'test-maps-key';
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.stubEnv('GOOGLE_MAPS_API_KEY', KEY);
    vi.stubEnv('NEXT_PUBLIC_GOOGLE_MAPS_API_KEY', '');
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ places: [] }) });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function sentBody(): Record<string, unknown> {
    return JSON.parse((fetchSpy.mock.calls[0]?.[1] as { body: string }).body);
  }

  it('includes locationBias.circle with the given centre + 30km radius when a bias is provided', async () => {
    await defaultGeocodeClient().searchText('Riverdale Library M4K', { lat: 43.6285, lng: -79.9618 });

    expect(sentBody()).toEqual({
      textQuery: 'Riverdale Library M4K',
      maxResultCount: 1,
      locationBias: {
        circle: {
          center: { latitude: 43.6285, longitude: -79.9618 },
          radius: 30000,
        },
      },
    });
  });

  it('omits locationBias entirely when no bias is provided', async () => {
    await defaultGeocodeClient().searchText('Halton Hills');

    expect(sentBody()).toEqual({ textQuery: 'Halton Hills', maxResultCount: 1 });
  });
});
