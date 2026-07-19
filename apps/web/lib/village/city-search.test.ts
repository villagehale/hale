import { describe, expect, it, vi } from 'vitest';
import {
  type CitySearchClient,
  parseCityCandidates,
  searchCanadianCities,
} from './geocode.js';

/**
 * Forward city search reuses the SAME Places provider + auth as venue geocoding
 * (no new provider — rule: reuse the seam). We assert: the response is mapped to
 * up to 6 {city, province} candidates with the province read from the
 * administrative_area_level_1 component; duplicates collapse; an empty query never
 * calls the provider; and a transport error degrades to [] (best-effort, never
 * throws to the route).
 */

/** A Places Text Search (New) response for two Canadian localities. */
const TORONTO = {
  displayName: { text: 'Toronto' },
  addressComponents: [
    { longText: 'Toronto', shortText: 'Toronto', types: ['locality', 'political'] },
    { longText: 'Ontario', shortText: 'ON', types: ['administrative_area_level_1', 'political'] },
    { longText: 'Canada', shortText: 'CA', types: ['country', 'political'] },
  ],
};
const LONDON = {
  displayName: { text: 'London' },
  addressComponents: [
    { longText: 'Ontario', shortText: 'ON', types: ['administrative_area_level_1', 'political'] },
  ],
};

describe('parseCityCandidates — {city, province} from the Places locality response', () => {
  it('maps displayName → city and administrative_area_level_1 → province', () => {
    const result = parseCityCandidates({ places: [TORONTO, LONDON] });
    expect(result).toEqual([
      { city: 'Toronto', province: 'ON' },
      { city: 'London', province: 'ON' },
    ]);
  });

  it('yields province null when no admin-area component is present, and skips a place with no city', () => {
    const result = parseCityCandidates({
      places: [
        { displayName: { text: 'Iqaluit' }, addressComponents: [] },
        { addressComponents: [] }, // no displayName → skipped
      ],
    });
    expect(result).toEqual([{ city: 'Iqaluit', province: null }]);
  });

  it('dedupes identical (city, province) and caps at 6', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      displayName: { text: `City${i}` },
      addressComponents: [
        { shortText: 'ON', types: ['administrative_area_level_1'] },
      ],
    }));
    const withDup = [TORONTO, TORONTO, ...many];
    const result = parseCityCandidates({ places: withDup });
    expect(result).toHaveLength(6);
    // Toronto appears once despite two identical entries.
    expect(result.filter((c) => c.city === 'Toronto')).toHaveLength(1);
  });

  it('returns [] for a malformed / empty response', () => {
    expect(parseCityCandidates(null)).toEqual([]);
    expect(parseCityCandidates({})).toEqual([]);
    expect(parseCityCandidates({ places: [] })).toEqual([]);
  });
});

describe('searchCanadianCities — reuse the geocode seam, best-effort', () => {
  it('returns the parsed candidates from the injected client', async () => {
    const client: CitySearchClient = { searchCities: vi.fn(async () => ({ places: [TORONTO] })) };
    const result = await searchCanadianCities('toron', client);
    expect(result).toEqual([{ city: 'Toronto', province: 'ON' }]);
    expect(client.searchCities).toHaveBeenCalledWith('toron');
  });

  it('never calls the provider for an empty/whitespace query', async () => {
    const client: CitySearchClient = { searchCities: vi.fn(async () => ({ places: [TORONTO] })) };
    expect(await searchCanadianCities('   ', client)).toEqual([]);
    expect(client.searchCities).not.toHaveBeenCalled();
  });

  it('degrades to [] on a transport error (never throws to the route)', async () => {
    const client: CitySearchClient = {
      searchCities: vi.fn(async () => {
        throw new Error('places quota exhausted');
      }),
    };
    expect(await searchCanadianCities('toronto', client)).toEqual([]);
  });
});
