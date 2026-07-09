import { schema } from '@hale/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VillageCandidateView } from './mappers';

// feed.ts pulls in next/cache + the auth chain via ~/lib/family; orderCandidates
// itself is pure, so stub those edges (the established idiom — see
// family/children-actions.test.ts) to import the helper without real infra. The
// loadVillageFeed suite below additionally stubs the read-path collaborators so
// the materialized-rank vs cold-miss behaviour is asserted without real infra.
vi.mock('next/cache', () => ({ unstable_cache: (fn: unknown) => fn }));
vi.mock('next/server', () => ({ after: (fn: () => void) => fn() }));
vi.mock('~/auth', () => ({ auth: vi.fn() }));

const currentFamilyIdMock = vi.fn();
const readVillageMock = vi.fn();
const getQueueMock = vi.fn();
const sendMock = vi.fn(async () => 'job-id');
const kickDrainMock = vi.fn();

// Rows the fake db returns, routed by the SELECTed table. Set per test.
let areaRow: { areaCoarse: string | null } | undefined;
let rankRow: { orderedIds: string[] } | undefined;

// Fakes the two SELECT chains loadVillageFeed runs: .from(families).where().limit()
// for the coarse area, .from(villageFeedRank).where().limit() for the stored
// order. Routed by table identity so it is order-independent.
const fakeDb = {
  select: () => ({
    from: (table: unknown) => ({
      where: () => ({
        limit: async () =>
          table === schema.families ? (areaRow ? [areaRow] : []) : rankRow ? [rankRow] : [],
      }),
    }),
  }),
} as never;

vi.mock('~/lib/db', () => ({ db: () => fakeDb }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: (...a: unknown[]) => currentFamilyIdMock(...a),
}));
vi.mock('./queries', () => ({ readVillage: (...a: unknown[]) => readVillageMock(...a) }));
vi.mock('./geocode', () => ({ geocodeVenue: async () => null }));
vi.mock('~/lib/queue', () => ({ getQueue: (...a: unknown[]) => getQueueMock(...a) }));
vi.mock('~/lib/cron/kick-drain', () => ({ kickDrain: (...a: unknown[]) => kickDrainMock(...a) }));
// The read path must NEVER call the ranker — mock it so any call would be caught.
const rankRecommendationsMock = vi.fn();
vi.mock('./rank/rank', () => ({
  rankRecommendations: (...a: unknown[]) => rankRecommendationsMock(...a),
}));

const { orderCandidates, loadVillageFeed } = await import('./feed');

/**
 * orderCandidates applies the agent's ordered ids to the candidate VIEWS. It is
 * the last integrity gate before render: the agent decides the order, but a card
 * is never dropped and never duplicated — the feed always contains exactly the
 * family's candidates, reordered.
 */

function view(id: string): VillageCandidateView {
  return {
    id,
    childId: null,
    title: `t-${id}`,
    kind: 'class',
    cadence: null,
    eventDate: null,
    seasons: null,
    discoveredAt: '2026-07-04T12:00:00.000Z',
    summary: '',
    coverageNote: null,
    sourceUrl: null,
    acceptHref: `/api/village/${id}/accept`,
    endorseHref: `/api/village/${id}/endorse`,
    saveHref: `/api/village/${id}/save`,
    shareHref: `/api/village/${id}/share`,
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
  };
}

describe('orderCandidates', () => {
  it('reorders the views to match the agent ordering', () => {
    const candidates = [view('a'), view('b'), view('c')];
    const ordered = orderCandidates(candidates, ['c', 'a', 'b']);
    expect(ordered.map((c) => c.id)).toEqual(['c', 'a', 'b']);
  });

  it('appends a candidate the ordering omitted (never drops a real card)', () => {
    const candidates = [view('a'), view('b'), view('c')];
    const ordered = orderCandidates(candidates, ['b']);
    expect(ordered.map((c) => c.id)).toEqual(['b', 'a', 'c']);
  });

  it('ignores an ordering id that has no matching view', () => {
    const candidates = [view('a'), view('b')];
    const ordered = orderCandidates(candidates, ['ghost', 'b', 'a']);
    expect(ordered.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('returns the discovery order unchanged when the ordering is empty', () => {
    const candidates = [view('a'), view('b')];
    expect(orderCandidates(candidates, []).map((c) => c.id)).toEqual(['a', 'b']);
  });
});

/**
 * loadVillageFeed is now a PURE DB read — the ~25s ranker is materialized in the
 * background and NEVER runs in this request path. The contract under test:
 *  - a stored village_feed_rank row → the candidates in that order, ranked:true;
 *  - no row yet → the discovery order now (ranked:false) AND a background rerank
 *    enqueued to warm the next visit;
 *  - fewer than two candidates → discovery order, nothing enqueued;
 *  - the ranker (rankRecommendations) is NEVER called from this path.
 */
const FAMILY = '11111111-1111-1111-1111-111111111111';

describe('loadVillageFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = 'postgres://test';
    areaRow = { areaCoarse: null };
    rankRow = undefined;
    currentFamilyIdMock.mockResolvedValue(FAMILY);
    getQueueMock.mockResolvedValue({ send: sendMock });
  });

  it('serves the STORED order with ranked:true when a rank row exists, without ranking', async () => {
    readVillageMock.mockResolvedValue({ candidates: [view('a'), view('b'), view('c')] });
    rankRow = { orderedIds: ['c', 'a', 'b'] };

    const feed = await loadVillageFeed();

    expect(feed.ranked).toBe(true);
    expect(feed.candidates.map((c) => c.id)).toEqual(['c', 'a', 'b']);
    expect(rankRecommendationsMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('serves the discovery order (ranked:false) and ENQUEUES a rerank when no row exists', async () => {
    readVillageMock.mockResolvedValue({ candidates: [view('a'), view('b'), view('c')] });
    rankRow = undefined;

    const feed = await loadVillageFeed();

    expect(feed.ranked).toBe(false);
    expect(feed.candidates.map((c) => c.id)).toEqual(['a', 'b', 'c']);
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock).toHaveBeenCalledWith('village.rerank', { family_id: FAMILY });
    expect(rankRecommendationsMock).not.toHaveBeenCalled();
  });

  it('returns the discovery order with no rerank when there are fewer than two candidates', async () => {
    readVillageMock.mockResolvedValue({ candidates: [view('a')] });
    rankRow = undefined;

    const feed = await loadVillageFeed();

    expect(feed.ranked).toBe(false);
    expect(feed.candidates.map((c) => c.id)).toEqual(['a']);
    expect(sendMock).not.toHaveBeenCalled();
    expect(rankRecommendationsMock).not.toHaveBeenCalled();
  });

  it('returns the empty feed with no DB read when no family is resolved', async () => {
    currentFamilyIdMock.mockResolvedValue(null);

    const feed = await loadVillageFeed();

    expect(feed).toEqual({ candidates: [], ranked: false, areaCoarse: null, coarseCenter: null });
    expect(readVillageMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });
});
