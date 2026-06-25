import { describe, expect, it, vi } from 'vitest';
import { type GeocodeClient, buildTextQuery, geocodeVenue } from './geocode.js';

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
    },
  ],
};

function fakeClient(impl: (q: string) => Promise<unknown>): { client: GeocodeClient; calls: string[] } {
  const calls: string[] = [];
  const client: GeocodeClient = {
    searchText: vi.fn(async (q: string) => {
      calls.push(q);
      return impl(q);
    }),
  };
  return { client, calls };
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
  it('stores coords + venue name/address for a resolvable venue', async () => {
    const { client, calls } = fakeClient(async () => RESOLVED);

    const result = await geocodeVenue('Riverdale Library kids storytime', AREA_COARSE, client);

    expect(result).toEqual({
      lat: 43.6777,
      lng: -79.3534,
      venueName: 'Riverdale Library',
      venueAddress: '370 Broadview Ave, Toronto, ON',
    });
    // Only the coarse area reaches Google — no precise location (rule #1).
    expect(calls).toEqual(['Riverdale Library kids storytime M4K']);
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
});
