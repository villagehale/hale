import { describe, expect, it } from 'vitest';

import type { CityCandidate, SavedArea } from './api-types';
import {
  MAX_SEARCH_RESULTS,
  MIN_QUERY_LENGTH,
  areaSubtitle,
  candidateSubtitle,
  cityFromReverseGeocode,
  filterSearchResults,
  headerLabel,
  regionMode,
  sameArea,
  shouldSearch,
  subtitleCopy,
  villageFeedKey,
} from './village-region';

function savedArea(partial: Partial<SavedArea> & { city: string }): SavedArea {
  return {
    id: partial.id ?? `id-${partial.city}`,
    city: partial.city,
    province: partial.province ?? null,
    note: partial.note ?? null,
    postalCode: partial.postalCode ?? null,
    isActive: partial.isActive ?? false,
    createdAt: partial.createdAt ?? '2026-01-01T00:00:00.000Z',
  };
}

describe('headerLabel', () => {
  it('reads the current "Near you" when the family has no active area', () => {
    expect(headerLabel(null)).toBe('Near you');
    expect(headerLabel(undefined)).toBe('Near you');
  });

  it("uses the active area's city when there is one", () => {
    expect(headerLabel({ city: 'Markham', province: 'ON' })).toBe('Markham');
  });
});

describe('subtitleCopy', () => {
  it('keeps the current copy verbatim when there is no area', () => {
    expect(subtitleCopy(null)).toBe('Find support, activities & resources near you.');
  });

  it('follows the active area city', () => {
    expect(subtitleCopy({ city: 'Markham', province: 'ON' })).toBe(
      'Find support, activities & resources in Markham.',
    );
  });
});

describe('regionMode (query empty ↔ non-empty)', () => {
  it('browses on an empty or whitespace query', () => {
    expect(regionMode('')).toBe('browsing');
    expect(regionMode('   ')).toBe('browsing');
  });

  it('searches on any non-empty query', () => {
    expect(regionMode('m')).toBe('searching');
    expect(regionMode('markham')).toBe('searching');
  });
});

describe('shouldSearch (min-length gate)', () => {
  it('does not fire a request below the minimum length', () => {
    expect(MIN_QUERY_LENGTH).toBe(2);
    expect(shouldSearch('')).toBe(false);
    expect(shouldSearch('m')).toBe(false);
    expect(shouldSearch(' m ')).toBe(false);
  });

  it('fires at or above the minimum length', () => {
    expect(shouldSearch('ma')).toBe(true);
    expect(shouldSearch('mark')).toBe(true);
  });
});

describe('filterSearchResults (exclude saved + cap)', () => {
  const candidates: CityCandidate[] = [
    { city: 'Markham', province: 'ON' },
    { city: 'Milton', province: 'ON' },
    { city: 'Mississauga', province: 'ON' },
  ];

  it('drops candidates already in the saved areas', () => {
    const saved = [savedArea({ city: 'Markham', province: 'ON' })];
    expect(filterSearchResults(candidates, saved)).toEqual([
      { city: 'Milton', province: 'ON' },
      { city: 'Mississauga', province: 'ON' },
    ]);
  });

  it('matches the saved area case-insensitively across city and province', () => {
    const saved = [savedArea({ city: 'markham', province: 'on' })];
    expect(filterSearchResults(candidates, saved).map((c) => c.city)).not.toContain('Markham');
  });

  it('keeps a same-name city in a different province', () => {
    const saved = [savedArea({ city: 'Markham', province: 'BC' })];
    expect(filterSearchResults(candidates, saved).map((c) => c.city)).toContain('Markham');
  });

  it('caps the list at MAX_SEARCH_RESULTS', () => {
    const many: CityCandidate[] = Array.from({ length: 8 }, (_, i) => ({
      city: `City ${i}`,
      province: 'ON',
    }));
    expect(filterSearchResults(many, [])).toHaveLength(MAX_SEARCH_RESULTS);
  });
});

describe('sameArea', () => {
  it('compares city+province case-insensitively', () => {
    expect(sameArea({ city: 'Markham', province: 'ON' }, 'markham', 'on')).toBe(true);
    expect(sameArea({ city: 'Markham', province: 'ON' }, 'Milton', 'ON')).toBe(false);
    expect(sameArea({ city: 'Guelph', province: null }, 'Guelph', undefined)).toBe(true);
  });
});

describe('cityFromReverseGeocode (on-device coarse mapper)', () => {
  it('maps city + region to {city, province}', () => {
    expect(cityFromReverseGeocode({ city: 'Toronto', region: 'Ontario' })).toEqual({
      city: 'Toronto',
      province: 'Ontario',
    });
  });

  it('falls back to subregion, then district, when city is absent', () => {
    expect(cityFromReverseGeocode({ city: null, subregion: 'Halton', region: 'ON' })).toEqual({
      city: 'Halton',
      province: 'ON',
    });
    expect(
      cityFromReverseGeocode({ city: null, subregion: null, district: 'Etobicoke', region: 'ON' }),
    ).toEqual({ city: 'Etobicoke', province: 'ON' });
  });

  it('returns a null province when the region is absent', () => {
    expect(cityFromReverseGeocode({ city: 'Guelph' })).toEqual({ city: 'Guelph', province: null });
  });

  it('returns null when no city-like field is present', () => {
    expect(cityFromReverseGeocode({ city: null, region: 'ON' })).toBeNull();
    expect(cityFromReverseGeocode(null)).toBeNull();
    expect(cityFromReverseGeocode(undefined)).toBeNull();
  });
});

describe('row subtitles', () => {
  it('prefers a saved area note, then province, else null', () => {
    expect(areaSubtitle(savedArea({ city: 'Halton Hills', note: 'Home area', province: 'ON' }))).toBe(
      'Home area',
    );
    expect(areaSubtitle(savedArea({ city: 'Milton', note: null, province: 'ON' }))).toBe('ON');
    expect(areaSubtitle(savedArea({ city: 'Nowhere', note: null, province: null }))).toBeNull();
  });

  it('shows a candidate province, or null', () => {
    expect(candidateSubtitle({ city: 'Markham', province: 'ON' })).toBe('ON');
    expect(candidateSubtitle({ city: 'Markham', province: null })).toBeNull();
  });
});

describe('villageFeedKey (reset feed filters on area switch)', () => {
  it('gives the no-area "Near you" feed a stable key', () => {
    expect(villageFeedKey(null)).toBe('near-you');
    expect(villageFeedKey(undefined)).toBe('near-you');
  });

  it('is stable for the same coarse area (a re-fetch must NOT reset the filters)', () => {
    expect(villageFeedKey({ city: 'Toronto', province: 'ON' })).toBe(
      villageFeedKey({ city: 'toronto', province: 'on' }),
    );
  });

  it('changes when the city changes (a switch MUST reset the filters)', () => {
    expect(villageFeedKey({ city: 'Toronto', province: 'ON' })).not.toBe(
      villageFeedKey({ city: 'Vancouver', province: 'BC' }),
    );
  });

  it('changes between an area and no area', () => {
    expect(villageFeedKey({ city: 'Toronto', province: 'ON' })).not.toBe(villageFeedKey(null));
  });
})
