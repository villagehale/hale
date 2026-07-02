import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile Village route returns loadVillage() verbatim; teen-attributed
// candidates/routine items are already redacted at the mapper inside the loader.
const authMock = vi.fn();
const loadVillageMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/village/queries', () => ({ loadVillage: () => loadVillageMock() }));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile village route must NOT touch the database (rule #1)');
    },
  };
});

const VILLAGE = { candidates: [{ id: 'cand-1', teenAttributed: false }], routine: null };

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/village/route');
  return GET();
}

describe('GET /api/mobile/village', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadVillageMock.mockReset();
    loadVillageMock.mockResolvedValue(VILLAGE);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never calls the loader', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(loadVillageMock).not.toHaveBeenCalled();
  });

  it('returns the village data for a signed-in parent', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(VILLAGE);
    expect(loadVillageMock).toHaveBeenCalledTimes(1);
  });
});
