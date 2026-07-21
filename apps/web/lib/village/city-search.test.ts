import { describe, expect, it, vi } from 'vitest';
import {
  type CityAutocompleteClient,
  autocompleteCanadianCities,
  parseCityPredictions,
} from './geocode.js';

/**
 * City search is Places Autocomplete (New): fuzzy, typo-tolerant typeahead restricted
 * to Canadian localities. We assert the response maps to coarse {placeId, city,
 * province, description} predictions (province read from the structured secondary
 * text, coordinates never read — rule #1); a suggestion missing a place id or city is
 * skipped; duplicates collapse; the session token threads through to the provider;
 * an empty query never calls the provider; and a transport error degrades to [].
 */

const pred = (over: Record<string, unknown> = {}) => ({
  placePrediction: {
    placeId: 'ChIJ-toronto',
    text: { text: 'Toronto, ON, Canada' },
    structuredFormat: {
      mainText: { text: 'Toronto' },
      secondaryText: { text: 'ON, Canada' },
    },
    ...over,
  },
});

describe('parseCityPredictions — coarse predictions from a Places Autocomplete response', () => {
  it('maps mainText → city, secondaryText → province, text → description, keeps placeId', () => {
    expect(parseCityPredictions({ suggestions: [pred()] })).toEqual([
      {
        placeId: 'ChIJ-toronto',
        city: 'Toronto',
        province: 'ON',
        description: 'Toronto, ON, Canada',
      },
    ]);
  });

  it('skips a suggestion with no place id or no main-text city', () => {
    const noId = pred({ placeId: undefined });
    const noCity = pred({
      structuredFormat: { mainText: { text: '' }, secondaryText: { text: 'ON, Canada' } },
    });
    expect(parseCityPredictions({ suggestions: [noId, noCity] })).toEqual([]);
  });

  it('yields province null when the secondary text is just the country or absent', () => {
    const p = pred({
      placeId: 'ChIJ-x',
      structuredFormat: { mainText: { text: 'Iqaluit' }, secondaryText: { text: 'Canada' } },
    });
    expect(parseCityPredictions({ suggestions: [p] })[0]?.province).toBeNull();
  });

  it('dedupes identical (city, province) and caps at 6', () => {
    const many = Array.from({ length: 9 }, (_, i) =>
      pred({
        placeId: `id-${i}`,
        structuredFormat: { mainText: { text: `City${i}` }, secondaryText: { text: 'ON, Canada' } },
      }),
    );
    const result = parseCityPredictions({ suggestions: [pred(), pred(), ...many] });
    expect(result).toHaveLength(6);
    expect(result.filter((c) => c.city === 'Toronto')).toHaveLength(1);
  });

  it('returns [] for a malformed / empty response', () => {
    expect(parseCityPredictions(null)).toEqual([]);
    expect(parseCityPredictions({})).toEqual([]);
    expect(parseCityPredictions({ suggestions: [] })).toEqual([]);
  });
});

describe('autocompleteCanadianCities — best-effort, session-token threaded', () => {
  it('returns the parsed predictions and threads the session token to the provider', async () => {
    const client: CityAutocompleteClient = {
      autocomplete: vi.fn(async () => ({ suggestions: [pred()] })),
    };
    const result = await autocompleteCanadianCities('toron', 'sess-123', client);
    expect(result[0]?.city).toBe('Toronto');
    expect(client.autocomplete).toHaveBeenCalledWith('toron', 'sess-123');
  });

  it('never calls the provider for an empty/whitespace query', async () => {
    const client: CityAutocompleteClient = {
      autocomplete: vi.fn(async () => ({ suggestions: [pred()] })),
    };
    expect(await autocompleteCanadianCities('   ', 'sess', client)).toEqual([]);
    expect(client.autocomplete).not.toHaveBeenCalled();
  });

  it('degrades to [] on a transport error (never throws to the caller)', async () => {
    const client: CityAutocompleteClient = {
      autocomplete: vi.fn(async () => {
        throw new Error('places quota exhausted');
      }),
    };
    expect(await autocompleteCanadianCities('toronto', 'sess', client)).toEqual([]);
  });
});
