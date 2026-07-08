import { describe, expect, it } from 'vitest';
import { VILLAGE_MAP_ZOOM, mapPointFor } from './village-map.js';

/**
 * The pure map-point resolver: a candidate plots a pin ONLY when it has a real
 * public venue coordinate. An online / no-venue activity, an unresolved geocode,
 * or a teen-redacted card (lat/lng nulled at the mapper) yields null → no map.
 */
describe('mapPointFor', () => {
  it('resolves the public venue point with its venue name as the marker title', () => {
    expect(
      mapPointFor({
        lat: 43.6777,
        lng: -79.3534,
        venueName: 'Riverdale Library',
        title: 'Toddler storytime',
      }),
    ).toEqual({ lat: 43.6777, lng: -79.3534, title: 'Riverdale Library' });
  });

  it('falls back to the candidate title when there is no venue name', () => {
    expect(
      mapPointFor({ lat: 43.6, lng: -79.4, venueName: null, title: 'Splash pad drop-in' }),
    ).toEqual({ lat: 43.6, lng: -79.4, title: 'Splash pad drop-in' });
  });

  it('returns null when either coordinate is missing (no pin at the equator)', () => {
    expect(mapPointFor({ lat: null, lng: -79.4, venueName: 'x', title: 't' })).toBeNull();
    expect(mapPointFor({ lat: 43.6, lng: null, venueName: 'x', title: 't' })).toBeNull();
    expect(mapPointFor({ lat: null, lng: null, venueName: null, title: 't' })).toBeNull();
  });

  it('exposes a neighbourhood-level default zoom', () => {
    expect(VILLAGE_MAP_ZOOM).toBe(15);
  });
});
