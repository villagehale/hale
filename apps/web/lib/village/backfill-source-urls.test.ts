import { schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';
import { backfillCandidateSourceUrls } from './backfill-source-urls.js';
import type { GeocodeResult } from './geocode.js';

/**
 * backfillCandidateSourceUrls re-runs the Places lookup for EXISTING candidates
 * whose source_url is missing and adopts the venue's real website, so an activity
 * card links to the venue instead of a Google search. We assert: it sets the
 * source_url from the resolved website; it leaves a candidate untouched when the
 * venue has no website (the Google-search fallback stays); it skips a candidate
 * whose family has no coarse area (rule #1 — we never disambiguate with a precise
 * home); and the lookup receives ONLY the title + the coarse area.
 */

const VENUE_WEBSITE = 'https://www.torontopubliclibrary.ca/riverdale';

/** Capture the (id, fields) of every update the backfill issues. */
function fakeDb(rows: Array<{ id: string; title: string; areaCoarse: string | null }>) {
  const updates: Array<{ id: string; set: Record<string, unknown> }> = [];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          where: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    }),
    update: (_table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          // Drizzle's eq(id, value) is opaque here; the backfill issues one update
          // per row in order, so we correlate by call index.
          updates.push({ id: rows[updates.length]?.id ?? '?', set });
        },
      }),
    }),
  } as never;
  return { db, updates };
}

function fakeGeocode(impl: (title: string, area: string) => Promise<GeocodeResult | null>) {
  const calls: Array<{ title: string; area: string }> = [];
  const geocode = vi.fn(async (title: string, area: string) => {
    calls.push({ title, area });
    return impl(title, area);
  });
  return { geocode, calls };
}

describe('backfillCandidateSourceUrls', () => {
  it('sets source_url from the resolved venue website', async () => {
    const { db, updates } = fakeDb([{ id: 'c1', title: 'Riverdale Library', areaCoarse: 'M4K' }]);
    const { geocode, calls } = fakeGeocode(async () => ({
      lat: 43.6,
      lng: -79.3,
      venueName: 'Riverdale Library',
      venueAddress: '370 Broadview Ave',
      website: VENUE_WEBSITE,
    }));

    const result = await backfillCandidateSourceUrls(db, { geocode });

    expect(result).toEqual({ scanned: 1, updated: 1 });
    expect(updates).toEqual([{ id: 'c1', set: { sourceUrl: VENUE_WEBSITE } }]);
    // Only the title + coarse area reach Places — never a precise location (rule #1).
    expect(calls).toEqual([{ title: 'Riverdale Library', area: 'M4K' }]);
  });

  it('leaves a candidate untouched when the venue has no website (Google-search fallback stays)', async () => {
    const { db, updates } = fakeDb([{ id: 'c1', title: 'A park', areaCoarse: 'M4K' }]);
    const { geocode } = fakeGeocode(async () => ({
      lat: 43.6,
      lng: -79.3,
      venueName: 'A park',
      venueAddress: '1 Park Lane',
    }));

    const result = await backfillCandidateSourceUrls(db, { geocode });

    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect(updates).toEqual([]);
  });

  it('skips a candidate whose family has no coarse area (rule #1)', async () => {
    const { db, updates } = fakeDb([{ id: 'c1', title: 'Online webinar', areaCoarse: null }]);
    const { geocode, calls } = fakeGeocode(async () => ({
      lat: 43.6,
      lng: -79.3,
      venueName: 'x',
      venueAddress: 'y',
      website: VENUE_WEBSITE,
    }));

    const result = await backfillCandidateSourceUrls(db, { geocode });

    expect(result).toEqual({ scanned: 1, updated: 0 });
    expect(updates).toEqual([]);
    // We never even call Places without a coarse area to disambiguate.
    expect(calls).toEqual([]);
  });

  it('updates row identity via the candidates table', async () => {
    const { db } = fakeDb([{ id: 'c1', title: 'V', areaCoarse: 'M4K' }]);
    const updateSpy = vi.spyOn(db as { update: (t: unknown) => unknown }, 'update');
    const { geocode } = fakeGeocode(async () => ({
      lat: 1,
      lng: 2,
      venueName: 'V',
      venueAddress: 'A',
      website: VENUE_WEBSITE,
    }));

    await backfillCandidateSourceUrls(db, { geocode });

    expect(updateSpy).toHaveBeenCalledWith(schema.villageCandidates);
  });
});
