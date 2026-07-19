import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile Village route returns loadVillage() merged with the curated Resources
// rail; teen-attributed candidates/routine items are already redacted at the mapper
// inside the loader.
const authMock = vi.fn();
const loadVillageMock = vi.fn();
const loadResourcesMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/village/queries', () => ({ loadVillage: () => loadVillageMock() }));
vi.mock('~/lib/village/curated-resources', () => ({
  loadCuratedResources: (...a: unknown[]) => loadResourcesMock(...a),
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

const VILLAGE = { candidates: [{ id: 'cand-1', teenAttributed: false }], routine: null };
const RESOURCES = [
  {
    id: 'res-1',
    name: 'Halton Region – EarlyON',
    category: 'EarlyON child & family centres',
    area: 'Halton Region',
    url: 'https://www.halton.ca/earlyon',
    description: 'Free EarlyON programs.',
  },
];

async function callGet(query = ''): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/village/route');
  return GET(new Request(`http://localhost/api/mobile/village${query}`));
}

describe('GET /api/mobile/village', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadVillageMock.mockReset();
    loadResourcesMock.mockReset();
    loadVillageMock.mockResolvedValue(VILLAGE);
    loadResourcesMock.mockResolvedValue(RESOURCES);
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
    expect(loadResourcesMock).not.toHaveBeenCalled();
  });

  it('returns the village data + curated resources for a signed-in parent', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet();

    expect(res.status).toBe(200);
    // The standing feed merges the village data with the Resources rail.
    expect(await res.json()).toEqual({ ...VILLAGE, resources: RESOURCES });
    expect(loadVillageMock).toHaveBeenCalledTimes(1);
    // No ?category → the full directory (category is undefined).
    expect(loadResourcesMock).toHaveBeenCalledWith(undefined);
  });

  it('passes a ?category= through to the curated-resources read (server-side filter)', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet('?category=EarlyON%20child%20%26%20family%20centres');

    expect(res.status).toBe(200);
    // The childcare page narrows the Resources server-side by category.
    expect(loadResourcesMock).toHaveBeenCalledWith('EarlyON child & family centres');
  });
});
