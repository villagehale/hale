import { describe, expect, it, vi } from 'vitest';
import {
  type CityCentroidClient,
  geocodeCanadianCity,
  parseCityCentroid,
} from './geocode.js';

/**
 * The onboarding location map needs the SEARCHED city's centroid to recentre a
 * decorative, city-level map. It reuses the same Places provider as the switcher
 * typeahead, but on a `locality` search, so `places.location` is the CITY CENTRE —
 * coarse by construction, never an address (rule #1). We assert: a locality with a
 * centroid maps to {city, province, lat, lng}; a locality WITHOUT a centroid is
 * null (we won't recentre on a guess); an empty query never calls the provider; and
 * any transport error degrades to null (best-effort — the map just doesn't move).
 */

const TORONTO = {
  displayName: { text: 'Toronto' },
  addressComponents: [
    { longText: 'Ontario', shortText: 'ON', types: ['administrative_area_level_1', 'political'] },
    { longText: 'Canada', shortText: 'CA', types: ['country', 'political'] },
  ],
  location: { latitude: 43.6532, longitude: -79.3832 },
};

describe('parseCityCentroid — {city, province, centroid} from a Places locality response', () => {
  it('maps displayName → city, admin_area_level_1 → province, location → centroid', () => {
    expect(parseCityCentroid({ places: [TORONTO] })).toEqual({
      city: 'Toronto',
      province: 'ON',
      lat: 43.6532,
      lng: -79.3832,
    });
  });

  it('is null when the locality has no centroid (nothing coarse to centre on)', () => {
    expect(
      parseCityCentroid({ places: [{ displayName: { text: 'Toronto' }, addressComponents: [] }] }),
    ).toBeNull();
  });

  it('yields province null when no admin-area component is present', () => {
    expect(
      parseCityCentroid({
        places: [{ displayName: { text: 'Iqaluit' }, location: { latitude: 63.7, longitude: -68.5 } }],
      }),
    ).toEqual({ city: 'Iqaluit', province: null, lat: 63.7, lng: -68.5 });
  });

  it('is null for a malformed / empty response (no place, no name)', () => {
    expect(parseCityCentroid(null)).toBeNull();
    expect(parseCityCentroid({})).toBeNull();
    expect(parseCityCentroid({ places: [] })).toBeNull();
    expect(parseCityCentroid({ places: [{ location: { latitude: 1, longitude: 2 } }] })).toBeNull();
  });
});

describe('geocodeCanadianCity — resolve one coarse city centroid, best-effort', () => {
  it('returns the parsed centroid from the injected client', async () => {
    const client: CityCentroidClient = {
      searchCityCentroid: vi.fn(async () => ({ places: [TORONTO] })),
    };
    expect(await geocodeCanadianCity('toron', client)).toEqual({
      city: 'Toronto',
      province: 'ON',
      lat: 43.6532,
      lng: -79.3832,
    });
    expect(client.searchCityCentroid).toHaveBeenCalledWith('toron');
  });

  it('never calls the provider for an empty/whitespace query', async () => {
    const client: CityCentroidClient = { searchCityCentroid: vi.fn(async () => ({ places: [TORONTO] })) };
    expect(await geocodeCanadianCity('   ', client)).toBeNull();
    expect(client.searchCityCentroid).not.toHaveBeenCalled();
  });

  it('degrades to null on a transport error (never throws to the client)', async () => {
    const client: CityCentroidClient = {
      searchCityCentroid: vi.fn(async () => {
        throw new Error('places quota exhausted');
      }),
    };
    expect(await geocodeCanadianCity('toronto', client)).toBeNull();
  });
});
