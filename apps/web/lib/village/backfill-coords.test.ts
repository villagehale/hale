import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { backfillCandidateCoords } from './backfill-coords.js';
import type { GeocodeResult, LatLng } from './geocode.js';

/**
 * backfillCandidateCoords re-runs the Places lookup for EXISTING candidates to
 * set (or, with `force`, correct) their map coords. We assert: the lookup is
 * biased to the family's COARSE-area centre (rule #1) so a same-named venue in
 * another city doesn't win the pin; the area centre is resolved once per distinct
 * area, not once per candidate; a candidate whose family has no coarse area is
 * skipped without any Places call; and `force` controls whether candidates that
 * already have coords are re-geocoded.
 */

type Row = { id: string; title: string; areaCoarse: string | null };

/** Captures the where-filter the scan ran with (to assert force vs null-only) and
 * the (id, fields) of every update the backfill issues. */
function fakeDb(rows: Row[]) {
  const updates: Array<{ id: string; set: Record<string, unknown> }> = [];
  let whereArg: unknown;
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: (arg: unknown) => {
            whereArg = arg;
            return { limit: async () => rows };
          },
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          updates.push({ id: rows[updates.length]?.id ?? '?', set });
        },
      }),
    }),
  } as never;
  return { db, updates, getWhereArg: () => whereArg };
}

function fakeGeocode(impl: (title: string, area: string, bias?: LatLng) => GeocodeResult | null) {
  const calls: Array<{ title: string; area: string; bias?: LatLng }> = [];
  const geocode = vi.fn(async (title: string, area: string, bias?: LatLng) => {
    calls.push({ title, area, bias });
    return impl(title, area, bias);
  });
  return { geocode, calls };
}

function fakeGeocodeArea(centers: Record<string, LatLng | null>) {
  const calls: string[] = [];
  const geocodeArea = vi.fn(async (area: string) => {
    calls.push(area);
    return centers[area] ?? null;
  });
  return { geocodeArea, calls };
}

const VENUE: GeocodeResult = {
  lat: 43.63,
  lng: -79.96,
  venueName: 'Halton Hills Library',
  venueAddress: '9 Church St, Georgetown, ON',
};

describe('backfillCandidateCoords', () => {
  it('biases the venue lookup to the family coarse-area centre (rule #1)', async () => {
    const center = { lat: 43.6285, lng: -79.9618 };
    const { db, updates } = fakeDb([{ id: 'c1', title: 'Library storytime', areaCoarse: 'L7G' }]);
    const { geocode, calls } = fakeGeocode(() => VENUE);
    const { geocodeArea } = fakeGeocodeArea({ L7G: center });

    const result = await backfillCandidateCoords(db, { geocode, geocodeArea });

    expect(result).toEqual({ scanned: 1, geocoded: 1 });
    // The lookup carried the coarse-area centre as the bias — never a precise home.
    expect(calls).toEqual([{ title: 'Library storytime', area: 'L7G', bias: center }]);
    expect(updates).toEqual([
      {
        id: 'c1',
        set: {
          lat: VENUE.lat,
          lng: VENUE.lng,
          venueName: VENUE.venueName,
          venueAddress: VENUE.venueAddress,
        },
      },
    ]);
  });

  it('resolves the area centre once per distinct area, not once per candidate', async () => {
    const center = { lat: 43.6285, lng: -79.9618 };
    const { db } = fakeDb([
      { id: 'c1', title: 'A', areaCoarse: 'L7G' },
      { id: 'c2', title: 'B', areaCoarse: 'L7G' },
      { id: 'c3', title: 'C', areaCoarse: 'M4K' },
    ]);
    const { geocode } = fakeGeocode(() => VENUE);
    const { geocodeArea, calls } = fakeGeocodeArea({ L7G: center, M4K: { lat: 43.6, lng: -79.3 } });

    await backfillCandidateCoords(db, { geocode, geocodeArea });

    // Two distinct areas → two area geocodes (not three, one per candidate).
    expect(calls).toEqual(['L7G', 'M4K']);
  });

  it('still geocodes (no bias) when the area centre can not be resolved', async () => {
    const { db, updates } = fakeDb([{ id: 'c1', title: 'Library', areaCoarse: 'L7G' }]);
    const { geocode, calls } = fakeGeocode(() => VENUE);
    const { geocodeArea } = fakeGeocodeArea({}); // area centre unresolved → null

    const result = await backfillCandidateCoords(db, { geocode, geocodeArea });

    expect(result).toEqual({ scanned: 1, geocoded: 1 });
    expect(calls).toEqual([{ title: 'Library', area: 'L7G', bias: undefined }]);
    expect(updates).toHaveLength(1);
  });

  it('skips a candidate whose family has no coarse area without any Places call (rule #1)', async () => {
    const { db, updates } = fakeDb([{ id: 'c1', title: 'Online webinar', areaCoarse: null }]);
    const { geocode, calls } = fakeGeocode(() => VENUE);
    const { geocodeArea, calls: areaCalls } = fakeGeocodeArea({});

    const result = await backfillCandidateCoords(db, { geocode, geocodeArea });

    expect(result).toEqual({ scanned: 1, geocoded: 0 });
    expect(updates).toEqual([]);
    // Neither the area nor the venue is geocoded without a coarse area.
    expect(calls).toEqual([]);
    expect(areaCalls).toEqual([]);
  });

  it('scans only null-coord candidates by default (cheap cron path)', async () => {
    const { db, getWhereArg } = fakeDb([]);
    const { geocode } = fakeGeocode(() => VENUE);
    const { geocodeArea } = fakeGeocodeArea({});

    await backfillCandidateCoords(db, { geocode, geocodeArea });

    // A defined where-filter (isNull(lat)) restricts the scan to null-coord rows.
    expect(getWhereArg()).toBeDefined();
  });

  it('with force, scans ALL candidates to correct existing wrong-city pins', async () => {
    const { db, getWhereArg } = fakeDb([]);
    const { geocode } = fakeGeocode(() => VENUE);
    const { geocodeArea } = fakeGeocodeArea({});

    await backfillCandidateCoords(db, { geocode, geocodeArea }, { force: true });

    // No where-filter → every candidate is rescanned (and re-geocoded).
    expect(getWhereArg()).toBeUndefined();
  });

  it('updates row identity via the candidates table', async () => {
    const { db } = fakeDb([{ id: 'c1', title: 'V', areaCoarse: 'L7G' }]);
    const updateSpy = vi.spyOn(db as { update: (t: unknown) => unknown }, 'update');
    const { geocode } = fakeGeocode(() => VENUE);
    const { geocodeArea } = fakeGeocodeArea({ L7G: { lat: 1, lng: 2 } });

    await backfillCandidateCoords(db, { geocode, geocodeArea });

    expect(updateSpy).toHaveBeenCalledWith(schema.villageCandidates);
  });
});
