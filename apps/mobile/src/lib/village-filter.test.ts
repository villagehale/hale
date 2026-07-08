import { describe, expect, it } from 'vitest';
import type { VillageCandidateView } from './api-types';
import {
  type SeasonFilterKey,
  activeFilterCount,
  applyFilters,
  filterByCadence,
  filterBySeasons,
} from './village-filter';

function view(overrides: Partial<VillageCandidateView> & { id: string }): VillageCandidateView {
  return {
    childId: null,
    title: `t-${overrides.id}`,
    kind: 'class',
    cadence: null,
    seasons: null,
    discoveredAt: '2026-07-04T12:00:00.000Z',
    summary: '',
    coverageNote: null,
    sourceUrl: null,
    acceptHref: `/api/village/${overrides.id}/accept`,
    endorseHref: `/api/village/${overrides.id}/endorse`,
    saveHref: `/api/village/${overrides.id}/save`,
    shareHref: `/api/village/${overrides.id}/share`,
    endorsementCount: 0,
    endorsedByFamily: false,
    saved: false,
    accepted: false,
    lat: null,
    lng: null,
    venueName: null,
    teenAttributed: false,
    ...overrides,
  };
}

const seasons = (...s: SeasonFilterKey[]) => new Set<SeasonFilterKey>(s);

describe('filterBySeasons', () => {
  const summerFall = view({ id: 'a', cadence: 'seasonal', seasons: ['summer', 'fall'] });
  const winter = view({ id: 'b', cadence: 'seasonal', seasons: ['winter'] });
  const ongoing = view({ id: 'c', cadence: 'ongoing', seasons: null });
  const rows = [summerFall, winter, ongoing];

  it('narrows nothing when no season is selected', () => {
    expect(filterBySeasons(rows, seasons())).toEqual(rows);
  });

  it('keeps a row when its seasons overlap the selection', () => {
    expect(filterBySeasons(rows, seasons('summer')).map((r) => r.id)).toEqual(['a']);
  });

  it('is a union across selected seasons', () => {
    expect(filterBySeasons(rows, seasons('summer', 'winter')).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('drops a season-less row (one-time / ongoing) once any season is selected', () => {
    // A season filter is a positive narrow; the ongoing row can't satisfy it.
    expect(filterBySeasons(rows, seasons('fall')).map((r) => r.id)).toEqual(['a']);
  });
});

describe('applyFilters — cadence AND seasons', () => {
  const rows = [
    view({ id: 'a', cadence: 'seasonal', seasons: ['summer'] }),
    view({ id: 'b', cadence: 'one-time', seasons: ['summer'] }),
    view({ id: 'c', cadence: 'ongoing', seasons: null }),
  ];

  it('intersects the two axes', () => {
    // seasonal cadence AND a summer season → only 'a'.
    expect(applyFilters(rows, 'seasonal', seasons('summer')).map((r) => r.id)).toEqual(['a']);
  });

  it('with both axes idle returns everything', () => {
    expect(applyFilters(rows, 'all', seasons()).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('activeFilterCount', () => {
  it('counts each active axis: cadence (when not "all") + seasons (when any picked)', () => {
    expect(activeFilterCount('all', seasons())).toBe(0);
    expect(activeFilterCount('seasonal', seasons())).toBe(1);
    expect(activeFilterCount('all', seasons('summer', 'fall'))).toBe(1);
    expect(activeFilterCount('one-time', seasons('winter'))).toBe(2);
  });
});

describe('filterByCadence still behaves', () => {
  it('maps year-round to the stored ongoing token', () => {
    const rows = [
      view({ id: 'a', cadence: 'ongoing' }),
      view({ id: 'b', cadence: 'seasonal' }),
    ];
    expect(filterByCadence(rows, 'year-round').map((r) => r.id)).toEqual(['a']);
  });
});
