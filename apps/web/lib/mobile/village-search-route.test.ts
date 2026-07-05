import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Mobile timeframe search over HTTP (the Server Action isn't mobile-callable):
 *   - GET /api/mobile/village?season=fall threads searchSeason through loadVillage
 *     so the app can render a search run; no season → the standing feed (unchanged).
 *   - POST /api/mobile/village/search rate-limits (paid run) then triggers a
 *     season-scoped discovery, mirroring the auth pattern of the other mobile
 *     routes. A limiter denial returns 429 with Retry-After (rule #8, structured).
 */

const authMock = vi.fn();
const loadVillageMock = vi.fn();
const enforceRateLimitMock = vi.fn();
const resolveFamilyMock = vi.fn();
const discoverMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/village/queries', () => ({
  loadVillage: (...a: unknown[]) => loadVillageMock(...a),
}));
vi.mock('~/lib/db', () => ({ db: () => ({ __db: true }) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
}));
vi.mock('~/lib/rate-limit/apply', () => ({
  enforceRateLimit: (...a: unknown[]) => enforceRateLimitMock(...a),
}));
vi.mock('~/lib/village/discover', () => ({
  discoverForFamily: (...a: unknown[]) => discoverMock(...a),
  defaultDiscoverDeps: () => ({ __deps: true }),
}));
vi.mock('~/lib/telemetry/langfuse', () => ({ flushTelemetry: async () => {} }));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile village GET must NOT touch the database (rule #1)');
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

describe('POST /api/mobile/village/search — trigger', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset().mockResolvedValue({ user: { id: 'ext-1' } });
    resolveFamilyMock.mockReset().mockResolvedValue('fam-1');
    enforceRateLimitMock.mockReset().mockResolvedValue(null);
    discoverMock.mockReset().mockResolvedValue({ status: 'discovered', insertedCount: 2 });
    vi.stubEnv('DATABASE_URL', 'postgres://test');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns 401 for a signed-out caller and never triggers discovery', async () => {
    authMock.mockResolvedValue(null);
    const res = await callPost({ season: 'fall' });
    expect(res.status).toBe(401);
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid season and never triggers discovery', async () => {
    const res = await callPost({ season: 'autumn' });
    expect(res.status).toBe(400);
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller has no resolved family', async () => {
    resolveFamilyMock.mockResolvedValue(null);
    const res = await callPost({ season: 'fall' });
    expect(res.status).toBe(403);
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it('returns the limiter 429 and never triggers discovery when over the cap', async () => {
    const { NextResponse } = await import('next/server');
    enforceRateLimitMock.mockResolvedValue(
      NextResponse.json(
        { error: 'rate_limited' },
        { status: 429, headers: { 'Retry-After': '900' } },
      ),
    );

    const res = await callPost({ season: 'fall' });

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('900');
    expect(enforceRateLimitMock).toHaveBeenCalledWith('village-search', 'fam-1');
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it('triggers a season-scoped discovery under the cap and returns its result', async () => {
    const res = await callPost({ season: 'fall' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'discovered', insertedCount: 2 });
    expect(discoverMock).toHaveBeenCalledWith(
      'fam-1',
      { __db: true },
      { __deps: true },
      {
        searchSeason: 'fall',
      },
    );
  });
});
