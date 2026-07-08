import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Saved route mirrors the village route: it gates (auth) and delegates to the
// loader that owns the DB + teen redaction (loadSavedVillageCandidates). The route
// itself never touches the DB (rule #1) — we poison createDb to prove it.
const authMock = vi.fn();
const loadSavedMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/village/queries', () => ({
  loadSavedVillageCandidates: () => loadSavedMock(),
}));
vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile saved route must NOT touch the database (rule #1)');
    },
  };
});

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/village/saved/route');
  return GET();
}

describe('GET /api/mobile/village/saved', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadSavedMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never loads', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(loadSavedMock).not.toHaveBeenCalled();
  });

  it('returns the saved candidates for a signed-in parent', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    loadSavedMock.mockResolvedValue([{ id: 'cand-1', saved: true }]);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidates: [{ id: 'cand-1', saved: true }] });
    expect(loadSavedMock).toHaveBeenCalledTimes(1);
  });
});
