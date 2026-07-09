import { describe, expect, it } from 'vitest';
import type { VillageCandidateView } from './mappers';
import { upcomingDatedCandidates } from './upcoming';

function view(overrides: Partial<VillageCandidateView> & { id: string }): VillageCandidateView {
  return {
    childId: null,
    title: `title-${overrides.id}`,
    kind: 'community_event',
    cadence: 'one-time',
    eventDate: null,
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
    rating: null,
    ratingCount: null,
    priceLevel: null,
    ageRange: null,
    indoorOutdoor: null,
    teenAttributed: false,
    ...overrides,
  };
}

describe('upcomingDatedCandidates', () => {
  it('keeps only dated events and orders them soonest-first', () => {
    const result = upcomingDatedCandidates([
      view({ id: 'undated', eventDate: null }),
      view({ id: 'sep', eventDate: '2026-09-12' }),
      view({ id: 'jul', eventDate: '2026-07-20' }),
      view({ id: 'aug', eventDate: '2026-08-01' }),
    ]);
    expect(result.map((c) => c.id)).toEqual(['jul', 'aug', 'sep']);
  });

  it('returns nothing when no candidate carries a date (honest empty state)', () => {
    expect(upcomingDatedCandidates([view({ id: 'a' }), view({ id: 'b' })])).toEqual([]);
  });

  it('never surfaces a teen-attributed candidate (its eventDate is nulled upstream, rule #1)', () => {
    const result = upcomingDatedCandidates([
      view({ id: 'teen', eventDate: null, teenAttributed: true }),
      view({ id: 'open', eventDate: '2026-07-20' }),
    ]);
    expect(result.map((c) => c.id)).toEqual(['open']);
  });
});
