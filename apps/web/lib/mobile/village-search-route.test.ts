import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mobile timeframe search over HTTP (the Server Action isn't mobile-callable):
 *   - GET /api/mobile/village?season=fall threads searchSeason through loadVillage
 *     so the app can render a search run; no season → the standing feed (unchanged).
 *   - POST /api/mobile/village/search delegates to the shared searchActivitiesForSeason
 *     core (auth + per-family rate limit + discovery all live there, behind ~/lib/db,
 *     so the route never touches the DB — rule #1). This route's own job is mapping
 *     the core's structured result to HTTP, which is what these tests pin.
 */

const authMock = vi.fn();
const loadVillageMock = vi.fn();
const loadResourcesMock = vi.fn();
const searchMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/village/queries', () => ({
  loadVillage: (...a: unknown[]) => loadVillageMock(...a),
  loadActiveArea: () => Promise.resolve(null),
}));
vi.mock('~/lib/village/curated-resources', () => ({
  loadCuratedResources: () => loadResourcesMock(),
}));
vi.mock('~/lib/village/search', () => ({
  searchActivitiesForSeason: (...a: unknown[]) => searchMock(...a),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile village route must NOT touch the database (rule #1)');
    },
  };
});

const VILLAGE = { candidates: [{ id: 'c1', teenAttributed: false }], routine: null };

async function callGet(url: string): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/village/route');
  return GET(new Request(url));
}

async function callPost(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/village/search/route');
  return POST(
    new Request('http://localhost/api/mobile/village/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('GET /api/mobile/village — season passthrough', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset().mockResolvedValue({ user: { id: 'ext-1' } });
    loadVillageMock.mockReset().mockResolvedValue(VILLAGE);
    loadResourcesMock.mockReset().mockResolvedValue([]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns 401 for a signed-out caller and never reads', async () => {
    authMock.mockResolvedValue(null);
    const res = await callGet('http://localhost/api/mobile/village');
    expect(res.status).toBe(401);
    expect(loadVillageMock).not.toHaveBeenCalled();
  });

  it('reads the STANDING feed (no opts) when no season is given', async () => {
    const res = await callGet('http://localhost/api/mobile/village');
    expect(res.status).toBe(200);
    expect(loadVillageMock).toHaveBeenCalledWith();
  });

  it('threads searchSeason through loadVillage when ?season=fall', async () => {
    const res = await callGet('http://localhost/api/mobile/village?season=fall');
    expect(res.status).toBe(200);
    expect(loadVillageMock).toHaveBeenCalledWith({ searchSeason: 'fall' });
  });

  it('ignores an invalid ?season and reads the standing feed', async () => {
    const res = await callGet('http://localhost/api/mobile/village?season=autumn');
    expect(res.status).toBe(200);
    expect(loadVillageMock).toHaveBeenCalledWith();
  });
});

describe('POST /api/mobile/village/search — maps the core result to HTTP', () => {
  beforeEach(() => {
    vi.resetModules();
    searchMock.mockReset();
    vi.stubEnv('DATABASE_URL', 'postgres://test');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns 503 (no_database) in a dev preview and never calls the core', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const res = await callPost({ season: 'fall' });
    expect(res.status).toBe(503);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('passes the requested season straight to the shared core', async () => {
    searchMock.mockResolvedValue({ status: 'discovered', insertedCount: 2 });
    await callPost({ season: 'fall' });
    expect(searchMock).toHaveBeenCalledWith('fall');
  });

  it('maps unauthenticated → 401', async () => {
    searchMock.mockResolvedValue({ status: 'unauthenticated' });
    const res = await callPost({ season: 'fall' });
    expect(res.status).toBe(401);
  });

  it('maps invalid_season → 400', async () => {
    searchMock.mockResolvedValue({ status: 'invalid_season' });
    const res = await callPost({ season: 'autumn' });
    expect(res.status).toBe(400);
  });

  it('maps no_family → 403', async () => {
    searchMock.mockResolvedValue({ status: 'no_family' });
    const res = await callPost({ season: 'fall' });
    expect(res.status).toBe(403);
  });

  it('maps rate_limited → 429 with Retry-After', async () => {
    searchMock.mockResolvedValue({ status: 'rate_limited', retryAfter: 900 });
    const res = await callPost({ season: 'fall' });
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('900');
  });

  it('returns the discovery result as 200 JSON', async () => {
    searchMock.mockResolvedValue({ status: 'discovered', insertedCount: 2 });
    const res = await callPost({ season: 'fall' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'discovered', insertedCount: 2 });
  });
});
