import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VillageSearchIntent } from './ai-search-intent';

/**
 * The natural-language search Server Action: auth-gate → rate-limit → derive the
 * (teen-safe) search context → run the search over real data. Auth is the spend gate
 * (no model call for preview/signed-out/no-family); the limiter denial is structured
 * (rule #8); and — the rule-#1 assertion — a teen child's age NEVER enters the parse
 * context (only non-teen ages + a bare hasTeen flag).
 */

const authConfiguredMock = vi.fn();
const authMock = vi.fn();
const resolveFamilyMock = vi.fn();
const rateLimitStatusMock = vi.fn();
const parseIntentMock = vi.fn();
const readVillageMock = vi.fn();
const resolveAreaMock = vi.fn();
const seasonDiscoveryMock = vi.fn();
const standingDiscoveryMock = vi.fn();
const flushMock = vi.fn();

let childRows: Array<{ dateOfBirth: string }> = [];

/** A fake db that answers the action's two direct reads without relying on table
 * identity (which breaks across vi.resetModules): the children read AWAITS `.where()`
 * → childRows; the feed-rank read calls `.where().limit(1)` → no stored rank ([]).
 * The pool read goes through the mocked readVillage. */
function fakeDb() {
  return {
    select: () => ({
      from: () => ({
        where: () => {
          const p = Promise.resolve(childRows) as Promise<unknown[]> & { limit: () => Promise<unknown[]> };
          p.limit = () => Promise.resolve([]);
          return p;
        },
      }),
    }),
  };
}

vi.mock('~/lib/auth-config', () => ({ authConfigured: () => authConfiguredMock() }));
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => fakeDb() }));
vi.mock('~/lib/family', () => ({ resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a) }));
vi.mock('~/lib/rate-limit/apply', () => ({ rateLimitStatus: (...a: unknown[]) => rateLimitStatusMock(...a) }));
vi.mock('~/lib/telemetry/langfuse', () => ({ flushTelemetry: () => flushMock() }));
vi.mock('./ai-search-parse', () => ({ parseVillageSearchIntent: (...a: unknown[]) => parseIntentMock(...a) }));
vi.mock('./queries', () => ({ readVillage: (...a: unknown[]) => readVillageMock(...a) }));
vi.mock('./areas', () => ({ resolveActiveAreaCoarse: (...a: unknown[]) => resolveAreaMock(...a) }));
vi.mock('./search', () => ({ searchActivitiesForSeason: (...a: unknown[]) => seasonDiscoveryMock(...a) }));
vi.mock('./discover-action', () => ({ findActivitiesAction: (...a: unknown[]) => standingDiscoveryMock(...a) }));
// after() runs its callback inline so the fire-and-forget trigger is observable.
vi.mock('next/server', () => ({ after: (cb: () => unknown) => cb() }));

const emptyIntent: VillageSearchIntent = {
  categories: [],
  keywords: [],
  season: null,
  childAgeMonths: null,
  familyScoped: false,
};

function view(id: string, over: Record<string, unknown> = {}) {
  return { id, title: id, kind: 'class', summary: '', ageRange: null, teenAttributed: false, ...over } as never;
}

async function call(prompt: string) {
  const { searchVillageAction } = await import('./ai-search-action');
  return searchVillageAction(prompt);
}

describe('searchVillageAction', () => {
  beforeEach(() => {
    vi.resetModules();
    childRows = [];
    authConfiguredMock.mockReset().mockReturnValue(true);
    authMock.mockReset().mockResolvedValue({ user: { id: 'ext-1' } });
    resolveFamilyMock.mockReset().mockResolvedValue('fam-1');
    rateLimitStatusMock.mockReset().mockResolvedValue({ allowed: true, retryAfterSec: 0 });
    parseIntentMock.mockReset().mockResolvedValue({ intent: emptyIntent, degraded: false });
    readVillageMock.mockReset().mockResolvedValue({ candidates: [], routine: null });
    resolveAreaMock.mockReset().mockResolvedValue('M4K');
    seasonDiscoveryMock.mockReset().mockResolvedValue({ status: 'discovered', insertedCount: 3 });
    standingDiscoveryMock.mockReset().mockResolvedValue({ status: 'discovered', insertedCount: 3 });
    flushMock.mockReset().mockResolvedValue(undefined);
  });

  it('refuses (unauthenticated) when auth is not configured — no model call', async () => {
    authConfiguredMock.mockReturnValue(false);
    expect(await call('montessori in fall')).toEqual({ status: 'unauthenticated' });
    expect(parseIntentMock).not.toHaveBeenCalled();
  });

  it('refuses (unauthenticated) for a signed-out caller', async () => {
    authMock.mockResolvedValue(null);
    expect(await call('montessori in fall')).toEqual({ status: 'unauthenticated' });
    expect(parseIntentMock).not.toHaveBeenCalled();
  });

  it('returns no_family when the caller has no resolved family', async () => {
    resolveFamilyMock.mockResolvedValue(null);
    expect(await call('montessori in fall')).toEqual({ status: 'no_family' });
    expect(parseIntentMock).not.toHaveBeenCalled();
  });

  it('returns a structured rate_limited and never calls the model when over the cap', async () => {
    rateLimitStatusMock.mockResolvedValue({ allowed: false, retryAfterSec: 42 });
    expect(await call('montessori in fall')).toEqual({ status: 'rate_limited', retryAfter: 42 });
    expect(rateLimitStatusMock).toHaveBeenCalledWith('village-ai-search', 'fam-1');
    expect(parseIntentMock).not.toHaveBeenCalled();
  });

  it('derives only NON-TEEN ages into the parse context, never a teen age (rule #1)', async () => {
    childRows = [{ dateOfBirth: '2009-01-01' }, { dateOfBirth: '2024-01-01' }]; // teen + toddler
    await call('swim for my kids');
    const passed = parseIntentMock.mock.calls[0]?.[0];
    expect(passed.hasTeen).toBe(true);
    expect(passed.childrenAgesMonths).toHaveLength(1);
    expect(passed.childrenAgesMonths[0]).toBeLessThan(156); // the toddler, never the teen
  });

  it('returns ok with the real filtered results when the pool is rich enough', async () => {
    readVillageMock.mockResolvedValue({ candidates: [view('a'), view('b'), view('c')], routine: null });
    const res = await call('anything near me');
    expect(res.status).toBe('ok');
    if (res.status === 'ok') {
      expect(res.results.map((r) => r.id)).toEqual(['a', 'b', 'c']);
      expect(res.discoveryKicked).toBe(false);
    }
    expect(flushMock).toHaveBeenCalled();
  });

  it('fires season discovery (fire-and-forget) for a thin, season-scoped result', async () => {
    parseIntentMock.mockResolvedValue({ intent: { ...emptyIntent, season: 'fall', keywords: ['montessori'] }, degraded: false });
    readVillageMock.mockResolvedValue({ candidates: [view('a', { title: 'montessori' })], routine: null });
    const res = await call('montessori in the fall');
    expect(res.status).toBe('ok');
    if (res.status === 'ok') expect(res.discoveryKicked).toBe(true);
    expect(readVillageMock).toHaveBeenCalledWith(expect.anything(), 'fam-1', { searchSeason: 'fall' });
    expect(seasonDiscoveryMock).toHaveBeenCalledWith('fall');
    expect(standingDiscoveryMock).not.toHaveBeenCalled();
  });
});
