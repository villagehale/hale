import { describe, expect, it } from 'vitest';
import { TEEN_REDACTED_PLACEHOLDER } from '~/lib/dashboard/mappers';
import { buildVillageMapModel } from './map-model.js';
import type { VillageCandidateView } from './mappers.js';

/**
 * buildVillageMapModel is the pure seam behind the village map. It decides what
 * gets a pin and where the map centers. We assert (rule #1): a marker is plotted
 * ONLY for a candidate carrying PUBLIC venue coords; coordless candidates stay
 * list-only; a teen-redacted candidate is NEVER plotted (even if it somehow
 * carried coords); the map centers on the COARSE-area centroid, never a precise
 * home; and markers preserve the ranked order they arrive in.
 */

function view(overrides: Partial<VillageCandidateView> & { id: string }): VillageCandidateView {
  return {
    childId: null,
    title: `title-${overrides.id}`,
    kind: 'class',
    cadence: null,
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

const COARSE_CENTER = { lat: 43.65, lng: -79.38 }; // a coarse FSA/city centroid

describe('buildVillageMapModel', () => {
  it('plots a marker only for candidates WITH public coords; coordless stay list-only', () => {
    const model = buildVillageMapModel(
      [
        view({ id: 'a', title: 'YMCA swim', lat: 43.67, lng: -79.35, venueName: 'YMCA' }),
        view({ id: 'b', title: 'online webinar' }), // no coords → no pin
        view({ id: 'c', title: 'library storytime', lat: 43.66, lng: -79.34 }),
      ],
      COARSE_CENTER,
    );

    expect(model.markers.map((m) => m.id)).toEqual(['a', 'c']);
    expect(model.markers[0]?.position).toEqual({ lat: 43.67, lng: -79.35 });
    expect(model.listOnlyCount).toBe(1);
  });

  it('centers on the COARSE-area centroid, never a precise home (rule #1)', () => {
    const model = buildVillageMapModel([view({ id: 'a' })], COARSE_CENTER);
    expect(model.center).toEqual(COARSE_CENTER);
  });

  it('never plots a teen-redacted candidate — even one carrying coords (rule #1)', () => {
    const model = buildVillageMapModel(
      [
        view({
          id: 'teen',
          title: TEEN_REDACTED_PLACEHOLDER,
          // A teen card is redacted at the mapper (coords null), but assert defence
          // in depth: even if coords leaked onto it, it must NOT become a marker.
          lat: 43.67,
          lng: -79.35,
          teenAttributed: true,
        }),
        view({ id: 'a', title: 'public class', lat: 43.66, lng: -79.34 }),
      ],
      COARSE_CENTER,
    );

    expect(model.markers.map((m) => m.id)).toEqual(['a']);
    expect(model.markers.some((m) => m.id === 'teen')).toBe(false);
  });

  it('preserves the ranked order of the markers', () => {
    const model = buildVillageMapModel(
      [
        view({ id: 'c', lat: 1, lng: 1 }),
        view({ id: 'a', lat: 2, lng: 2 }),
        view({ id: 'b', lat: 3, lng: 3 }),
      ],
      COARSE_CENTER,
    );
    expect(model.markers.map((m) => m.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps center null when the coarse area itself could not be resolved', () => {
    const model = buildVillageMapModel([view({ id: 'a', lat: 1, lng: 1 })], null);
    expect(model.center).toBeNull();
    // A marker still exists; the component fits bounds to the public venue.
    expect(model.markers).toHaveLength(1);
  });
});
