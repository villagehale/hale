import { describe, expect, it, vi } from 'vitest';
import {
  MIN_RESULTS,
  type SearchContext,
  type SearchDeps,
  filterCandidatesByIntent,
  runVillageSearch,
} from './ai-search';
import type { VillageSearchIntent } from './ai-search-intent';
import type { VillageCandidateView } from './mappers';

const emptyIntent: VillageSearchIntent = {
  categories: [],
  keywords: [],
  season: null,
  childAgeMonths: null,
  familyScoped: false,
};

/** A minimal candidate view for filtering/ordering tests — only the fields the
 * search reads matter; the rest are honest null defaults. */
function candidate(over: Partial<VillageCandidateView> & { id: string }): VillageCandidateView {
  return {
    childId: null,
    title: 'Untitled',
    kind: 'class',
    cadence: 'ongoing',
    eventDate: null,
    seasons: null,
    discoveredAt: '2026-07-01T00:00:00.000Z',
    summary: '',
    coverageNote: null,
    sourceUrl: null,
    acceptHref: '',
    endorseHref: '',
    saveHref: '',
    shareHref: '',
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
    ...over,
  };
}

const ctx: SearchContext = {
  prompt: 'montessori in the fall',
  database: {} as never,
  familyId: 'fam-1',
  childrenAgesMonths: [40],
  hasTeen: false,
  areaCoarse: 'M4K',
};

function deps(over: Partial<SearchDeps>): SearchDeps {
  return {
    parseIntent: vi.fn(async () => ({ intent: emptyIntent, degraded: false })),
    readPool: vi.fn(async () => []),
    readStoredRank: vi.fn(async () => null),
    kickDiscovery: vi.fn(),
    ...over,
  };
}

describe('filterCandidatesByIntent — narrows real rows, never invents one', () => {
  it('keeps only candidates whose own fields contain a keyword', () => {
    const rows = [
      candidate({ id: 'a', title: 'Montessori Morning' }),
      candidate({ id: 'b', title: 'Soccer Club' }),
      candidate({ id: 'c', summary: 'A gentle montessori-inspired playgroup' }),
    ];
    const out = filterCandidatesByIntent(rows, { ...emptyIntent, keywords: ['montessori'] });
    expect(out.map((c) => c.id)).toEqual(['a', 'c']);
  });

  it('excludes teen-attributed cards from focused results (rule #1)', () => {
    const rows = [
      candidate({ id: 'teen', kind: 'class', teenAttributed: true }),
      candidate({ id: 'ok', kind: 'class' }),
    ];
    // A bare category browse (no keywords) still drops the locked teen card.
    expect(filterCandidatesByIntent(rows, emptyIntent).map((c) => c.id)).toEqual(['ok']);
  });

  it('narrows to outdoor rows for a playgrounds-only category', () => {
    const rows = [
      candidate({ id: 'park', indoorOutdoor: 'outdoor' }),
      candidate({ id: 'gym', indoorOutdoor: 'indoor' }),
    ];
    const out = filterCandidatesByIntent(rows, { ...emptyIntent, categories: ['playgrounds'] });
    expect(out.map((c) => c.id)).toEqual(['park']);
  });

  it('returns the category-scoped pool unchanged when there are no keywords', () => {
    const rows = [candidate({ id: 'a' }), candidate({ id: 'b' })];
    expect(filterCandidatesByIntent(rows, emptyIntent).map((c) => c.id)).toEqual(['a', 'b']);
  });
});

describe('runVillageSearch — pool selection, thin trigger, echo', () => {
  it('reads the SEASON search-run pool when the intent names a season', async () => {
    const readPool = vi.fn(async () => [candidate({ id: 'x' })]);
    await runVillageSearch(ctx, deps({
      parseIntent: async () => ({ intent: { ...emptyIntent, season: 'fall', keywords: [] }, degraded: false }),
      readPool,
    }));
    expect(readPool).toHaveBeenCalledWith(ctx.database, 'fam-1', 'fall');
  });

  it('reads the STANDING pool (season null) and applies the stored agent rank order', async () => {
    const pool = [candidate({ id: 'a' }), candidate({ id: 'b' }), candidate({ id: 'c' }), candidate({ id: 'd' })];
    const readPool = vi.fn(async () => pool);
    const readStoredRank = vi.fn(async () => ['c', 'a']);
    const result = await runVillageSearch(ctx, deps({
      parseIntent: async () => ({ intent: emptyIntent, degraded: false }),
      readPool,
      readStoredRank,
    }));
    expect(readPool).toHaveBeenCalledWith(ctx.database, 'fam-1', null);
    // stored rank floats c, a to the front; the rest keep order
    expect(result.results.map((c) => c.id)).toEqual(['c', 'a', 'b', 'd']);
  });

  it('kicks discovery for a thin result set and flags it', async () => {
    const kickDiscovery = vi.fn();
    const result = await runVillageSearch(ctx, deps({
      parseIntent: async () => ({ intent: { ...emptyIntent, season: 'winter', keywords: ['swim'] }, degraded: false }),
      readPool: async () => [candidate({ id: 'only', title: 'swim' })], // 1 < MIN_RESULTS
      kickDiscovery,
    }));
    expect(result.discoveryKicked).toBe(true);
    expect(kickDiscovery).toHaveBeenCalledWith(ctx, 'winter');
  });

  it('does NOT kick discovery when the pool is rich enough', async () => {
    const kickDiscovery = vi.fn();
    const pool = Array.from({ length: MIN_RESULTS }, (_, i) => candidate({ id: `s${i}`, title: 'swim' }));
    const result = await runVillageSearch(ctx, deps({
      parseIntent: async () => ({ intent: { ...emptyIntent, keywords: ['swim'] }, degraded: false }),
      readPool: async () => pool,
      kickDiscovery,
    }));
    expect(result.discoveryKicked).toBe(false);
    expect(kickDiscovery).not.toHaveBeenCalled();
  });

  it('never kicks a paid discovery on empty-intent chatter', async () => {
    const kickDiscovery = vi.fn();
    const result = await runVillageSearch(ctx, deps({
      parseIntent: async () => ({ intent: emptyIntent, degraded: true }),
      readPool: async () => [],
      kickDiscovery,
    }));
    expect(result.discoveryKicked).toBe(false);
    expect(kickDiscovery).not.toHaveBeenCalled();
  });

  it('surfaces the honest interpretation echo and the degraded flag', async () => {
    const result = await runVillageSearch(ctx, deps({
      parseIntent: async () => ({
        intent: { categories: ['childcare'], keywords: ['montessori'], season: 'fall', childAgeMonths: 40, familyScoped: false },
        degraded: true,
      }),
      readPool: async () => [candidate({ id: 'a', title: 'Montessori' }), candidate({ id: 'b', title: 'Montessori 2' }), candidate({ id: 'c', title: 'Montessori 3' })],
    }));
    expect(result.interpretation).toBe('montessori · childcare · starting fall · for a 3-year-old');
    expect(result.degraded).toBe(true);
  });
});
