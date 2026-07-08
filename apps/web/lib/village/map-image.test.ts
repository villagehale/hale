import { describe, expect, it, vi } from 'vitest';
import { buildStaticMapUrl, readCandidateVenuePoint } from './map-image.js';

vi.mock('~/lib/family', () => ({ resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a) }));
const resolveFamilyMock = vi.fn();

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';

/** A db handle whose candidate select resolves the given rows. */
function fakeDb(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({ where: () => ({ limit: () => Promise.resolve(rows) }) }),
    }),
  } as never;
}

describe('buildStaticMapUrl', () => {
  it('plots a single marker at the venue point with a neighbourhood zoom and carries the key', () => {
    const url = new URL(
      buildStaticMapUrl({ lat: 43.6532, lng: -79.3832, apiKey: 'k-123' }),
    );

    expect(url.origin + url.pathname).toBe('https://maps.googleapis.com/maps/api/staticmap');
    expect(url.searchParams.get('center')).toBe('43.6532,-79.3832');
    expect(url.searchParams.get('zoom')).toBe('15');
    expect(url.searchParams.get('key')).toBe('k-123');
    // The marker sits exactly on the plotted point — same coordinate as center.
    expect(url.searchParams.get('markers')).toContain('43.6532,-79.3832');
  });

  it('honours a custom thumbnail size', () => {
    const url = new URL(
      buildStaticMapUrl({ lat: 1, lng: 2, apiKey: 'k', widthPx: 200, heightPx: 100 }),
    );
    expect(url.searchParams.get('size')).toBe('200x100');
  });
});

describe('readCandidateVenuePoint (family-scoped, rule #1)', () => {
  it('returns the public venue point for the caller family candidate', async () => {
    resolveFamilyMock.mockResolvedValue(FAMILY_ID);
    const point = await readCandidateVenuePoint(
      'ext-1',
      '44444444-4444-4444-8444-444444444444',
      fakeDb([{ lat: 43.65, lng: -79.38 }]),
    );
    expect(point).toEqual({ lat: 43.65, lng: -79.38 });
  });

  it('returns null when the candidate has no venue point (online / no-venue / teen-redacted)', async () => {
    resolveFamilyMock.mockResolvedValue(FAMILY_ID);
    const point = await readCandidateVenuePoint(
      'ext-1',
      '44444444-4444-4444-8444-444444444444',
      fakeDb([{ lat: null, lng: null }]),
    );
    expect(point).toBeNull();
  });

  it('returns null (no plot) when the caller has no family', async () => {
    resolveFamilyMock.mockResolvedValue(null);
    const point = await readCandidateVenuePoint(
      'ext-1',
      '44444444-4444-4444-8444-444444444444',
      fakeDb([{ lat: 43.65, lng: -79.38 }]),
    );
    expect(point).toBeNull();
  });
});
