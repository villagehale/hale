import { describe, expect, it, vi } from 'vitest';
import { type CityDetailsClient, parseCityDetails, resolveCityPlace } from './geocode.js';

/**
 * A selected city prediction is resolved to its centroid via Place Details (New),
 * threaded on the SAME session token as the autocomplete calls (one billed session).
 * We assert the details response maps to {city, province, centroid} (province from
 * administrative_area_level_1, coordinates = the locality centre, rule #1); a details
 * payload with no centroid is null (we won't recentre on a guess); an empty place id
 * never calls the provider; and a transport error degrades to null.
 */

const TORONTO_DETAILS = {
  displayName: { text: 'Toronto' },
  addressComponents: [
    { longText: 'Ontario', shortText: 'ON', types: ['administrative_area_level_1', 'political'] },
    { longText: 'Canada', shortText: 'CA', types: ['country', 'political'] },
  ],
  location: { latitude: 43.6532, longitude: -79.3832 },
};

describe('parseCityDetails — {city, province, centroid} from a Place Details response', () => {
  it('maps displayName → city, admin_area_level_1 → province, location → centroid', () => {
    expect(parseCityDetails(TORONTO_DETAILS)).toEqual({
      city: 'Toronto',
      province: 'ON',
      lat: 43.6532,
      lng: -79.3832,
    });
  });

  it('is null when the place has no centroid (nothing coarse to centre on)', () => {
    expect(
      parseCityDetails({ displayName: { text: 'Toronto' }, addressComponents: [] }),
    ).toBeNull();
  });

  it('yields province null when no admin-area component is present', () => {
    expect(
      parseCityDetails({
        displayName: { text: 'Iqaluit' },
        location: { latitude: 63.7, longitude: -68.5 },
      }),
    ).toEqual({ city: 'Iqaluit', province: null, lat: 63.7, lng: -68.5 });
  });

  it('is null for a malformed / empty response (no name, no centroid)', () => {
    expect(parseCityDetails(null)).toBeNull();
    expect(parseCityDetails({})).toBeNull();
    expect(parseCityDetails({ location: { latitude: 1, longitude: 2 } })).toBeNull();
  });
});

describe('resolveCityPlace — resolve a selected place id, best-effort, token threaded', () => {
  it('returns the centroid and threads the session token to the provider', async () => {
    const client: CityDetailsClient = { details: vi.fn(async () => TORONTO_DETAILS) };
    expect(await resolveCityPlace('ChIJ-toronto', 'sess-123', client)).toEqual({
      city: 'Toronto',
      province: 'ON',
      lat: 43.6532,
      lng: -79.3832,
    });
    expect(client.details).toHaveBeenCalledWith('ChIJ-toronto', 'sess-123');
  });

  it('never calls the provider for an empty place id', async () => {
    const client: CityDetailsClient = { details: vi.fn(async () => TORONTO_DETAILS) };
    expect(await resolveCityPlace('  ', 'sess', client)).toBeNull();
    expect(client.details).not.toHaveBeenCalled();
  });

  it('degrades to null on a transport error (never throws to the caller)', async () => {
    const client: CityDetailsClient = {
      details: vi.fn(async () => {
        throw new Error('place details 500');
      }),
    };
    expect(await resolveCityPlace('ChIJ-toronto', 'sess', client)).toBeNull();
  });
});
