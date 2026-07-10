import { describe, expect, it } from 'vitest';
import {
  CHILDCARE_RESOURCE_CATEGORY,
  filterActivities,
  filterResources,
} from './board-filter.js';
import type { CuratedResourceView } from './curated-resources.js';
import type { VillageCandidateView } from './mappers.js';

/**
 * The Village board's content-type filter + free-text search, over the REAL loaded
 * data (candidates vs curated resources). We assert each pill routes to the right
 * dataset and that "Childcare" narrows to the real curated category — no fabricated
 * tab, no cross-column bleed.
 */

function candidate(
  overrides: Partial<VillageCandidateView> & { id: string },
): VillageCandidateView {
  return {
    childId: null,
    title: `title-${overrides.id}`,
    kind: 'class',
    cadence: null,
    eventDate: null,
    seasons: null,
    discoveredAt: '2026-07-04T12:00:00.000Z',
    summary: `summary-${overrides.id}`,
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

function resource(overrides: Partial<CuratedResourceView> & { id: string }): CuratedResourceView {
  return {
    name: `name-${overrides.id}`,
    category: 'Public health',
    area: 'Halton Region',
    url: `https://example.test/${overrides.id}`,
    description: `desc-${overrides.id}`,
    ...overrides,
  };
}

const CANDIDATES = [
  candidate({ id: 'swim', title: 'Toddler swim', kind: 'class', summary: 'lessons at the Y' }),
  candidate({ id: 'story', title: 'Story hour', kind: 'library', summary: 'at the library' }),
];

const RESOURCES = [
  resource({ id: 'earlyon', name: 'EarlyON Georgetown', category: CHILDCARE_RESOURCE_CATEGORY }),
  resource({ id: 'health', name: 'Breastfeeding line', category: 'Public health' }),
];

describe('filterActivities — content-type routing', () => {
  it('shows every candidate under "all" and under "activities"', () => {
    expect(filterActivities(CANDIDATES, 'all', '').map((c) => c.id)).toEqual(['swim', 'story']);
    expect(filterActivities(CANDIDATES, 'activities', '').map((c) => c.id)).toEqual([
      'swim',
      'story',
    ]);
  });

  it('shows NO candidates under "resources" or "childcare" (the column is hidden)', () => {
    expect(filterActivities(CANDIDATES, 'resources', '')).toEqual([]);
    expect(filterActivities(CANDIDATES, 'childcare', '')).toEqual([]);
  });

  it('searches a candidate by title, kind, and summary', () => {
    expect(filterActivities(CANDIDATES, 'all', 'swim').map((c) => c.id)).toEqual(['swim']);
    expect(filterActivities(CANDIDATES, 'all', 'library').map((c) => c.id)).toEqual(['story']);
    expect(filterActivities(CANDIDATES, 'all', 'lessons').map((c) => c.id)).toEqual(['swim']);
    expect(filterActivities(CANDIDATES, 'all', 'zzz')).toEqual([]);
  });
});

describe('filterResources — content-type routing', () => {
  it('shows every resource under "all" and under "resources"', () => {
    expect(filterResources(RESOURCES, 'all', '').map((r) => r.id)).toEqual(['earlyon', 'health']);
    expect(filterResources(RESOURCES, 'resources', '').map((r) => r.id)).toEqual([
      'earlyon',
      'health',
    ]);
  });

  it('shows NO resources under "activities" (the column is hidden)', () => {
    expect(filterResources(RESOURCES, 'activities', '')).toEqual([]);
  });

  it('narrows "childcare" to the real childcare curated category only', () => {
    // Only the EarlyON child & family centres row survives — the public-health row
    // is a real resource but not childcare.
    expect(filterResources(RESOURCES, 'childcare', '').map((r) => r.id)).toEqual(['earlyon']);
  });

  it('searches a resource by name, category, and description within the active filter', () => {
    expect(filterResources(RESOURCES, 'all', 'breastfeeding').map((r) => r.id)).toEqual(['health']);
    expect(filterResources(RESOURCES, 'resources', 'earlyon').map((r) => r.id)).toEqual(['earlyon']);
    // Search composes with the childcare narrowing: a query that only the
    // public-health row matches yields nothing under "childcare".
    expect(filterResources(RESOURCES, 'childcare', 'breastfeeding')).toEqual([]);
  });
});
