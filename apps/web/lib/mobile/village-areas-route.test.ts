import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The saved-areas region-switcher routes. The route resolves the family from the
 * SESSION (currentFamilyId) and passes THAT familyId to the family-scoped areas lib
 * — never a body-supplied one — so a caller can only ever touch their own areas
 * (cross-family isolation, rule #1). These pin the auth gate, the coordinate
 * refusal (rule #1), the session→lib family-scoping, and the status mapping. The
 * areas lib (which owns the query building + audit) is mocked; hasCoordinateFields
 * stays REAL so the route's coordinate refusal is genuinely exercised.
 */

const authMock = vi.fn();
const familyMock = vi.fn();
const userMock = vi.fn();
const listAreasMock = vi.fn();
const addAreaMock = vi.fn();
const setActiveMock = vi.fn();
const searchMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: (...a: unknown[]) => familyMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => userMock(...a),
}));
vi.mock('~/lib/village/areas', async (importActual) => ({
  ...(await importActual<typeof import('~/lib/village/areas')>()),
  listAreas: (...a: unknown[]) => listAreasMock(...a),
  addArea: (...a: unknown[]) => addAreaMock(...a),
  setActiveArea: (...a: unknown[]) => setActiveMock(...a),
}));
vi.mock('~/lib/village/geocode', () => ({
  searchCanadianCities: (...a: unknown[]) => searchMock(...a),
}));

const FAMILY_ID = 'fam-1';
const USER_ID = 'user-1';
const AREAS = [
  { id: 'a1', city: 'Burlington', province: 'ON', note: 'home', postalCode: 'L7G 0A1', isActive: true, createdAt: '2026-07-01T00:00:00.000Z' },
  { id: 'a2', city: 'Ottawa', province: 'ON', note: "grandma's", postalCode: 'K1P 1J1', isActive: false, createdAt: '2026-07-02T00:00:00.000Z' },
];

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/village/areas/route');
  return GET();
}
async function callPost(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/village/areas/route');
  return POST(
    new Request('http://localhost/api/mobile/village/areas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}
async function callSearch(url: string): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/village/areas/search/route');
  return GET(new Request(url));
}

describe('GET /api/mobile/village/areas', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    authMock.mockReset().mockResolvedValue({ user: { id: 'ext-1' } });
    familyMock.mockReset().mockResolvedValue(FAMILY_ID);
    listAreasMock.mockReset().mockResolvedValue(AREAS);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns 401 for a signed-out caller and never reads', async () => {
    authMock.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(401);
    expect(familyMock).not.toHaveBeenCalled();
    expect(listAreasMock).not.toHaveBeenCalled();
  });

  it('returns 503 in a dev preview (no DATABASE_URL)', async () => {
    vi.stubEnv('DATABASE_URL', '');
    const res = await callGet();
    expect(res.status).toBe(503);
  });

  it('returns 403 when the signed-in user has no resolved family', async () => {
    familyMock.mockResolvedValue(null);
    const res = await callGet();
    expect(res.status).toBe(403);
    expect(listAreasMock).not.toHaveBeenCalled();
  });

  it('lists the family-scoped areas + the active id, reading ONLY the session family', async () => {
    const res = await callGet();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ areas: AREAS, activeAreaId: 'a1' });
    // Isolation: the list read is scoped to the session-resolved family, never a
    // client value.
    expect(listAreasMock).toHaveBeenCalledWith({}, FAMILY_ID);
  });
});

describe('POST /api/mobile/village/areas', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    authMock.mockReset().mockResolvedValue({ user: { id: 'ext-1' } });
    familyMock.mockReset().mockResolvedValue(FAMILY_ID);
    userMock.mockReset().mockResolvedValue(USER_ID);
    listAreasMock.mockReset().mockResolvedValue(AREAS);
    addAreaMock.mockReset().mockResolvedValue({ status: 'added', area: AREAS[1] });
    setActiveMock.mockReset().mockResolvedValue({ status: 'activated' });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('REFUSES a payload carrying coordinates (400) before resolving the family or writing (rule #1)', async () => {
    const res = await callPost({ action: 'add', city: 'Toronto', lat: 43.65, lng: -79.38 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'coordinates_forbidden' });
    expect(familyMock).not.toHaveBeenCalled();
    expect(addAreaMock).not.toHaveBeenCalled();
  });

  it('adds an area scoped to the SESSION family, ignoring any body-supplied familyId (isolation)', async () => {
    const res = await callPost({
      action: 'add',
      city: 'Ottawa',
      province: 'ON',
      note: "grandma's",
      // A smuggled foreign familyId must be ignored — the route uses the session's.
      familyId: 'someone-elses-family',
    });
    expect(res.status).toBe(200);
    expect(addAreaMock).toHaveBeenCalledWith(
      {},
      {
        familyId: FAMILY_ID,
        userId: USER_ID,
        input: { city: 'Ottawa', province: 'ON', note: "grandma's", postalCode: undefined },
      },
    );
    // Success returns the refreshed family-scoped list.
    expect(await res.json()).toEqual({ areas: AREAS, activeAreaId: 'a1' });
  });

  it('maps cap_reached → 409 and city_required → 400', async () => {
    addAreaMock.mockResolvedValueOnce({ status: 'cap_reached' });
    expect((await callPost({ action: 'add', city: 'Ninth' })).status).toBe(409);

    addAreaMock.mockResolvedValueOnce({ status: 'invalid', error: 'city_required' });
    expect((await callPost({ action: 'add', city: '' })).status).toBe(400);
  });

  it('activates an area by id, scoped to the session family', async () => {
    const res = await callPost({ action: 'setActive', areaId: 'a2' });
    expect(res.status).toBe(200);
    expect(setActiveMock).toHaveBeenCalledWith({}, { familyId: FAMILY_ID, userId: USER_ID, areaId: 'a2' });
  });

  it("maps a not-found area (another family's id) → 404 (cross-family isolation)", async () => {
    setActiveMock.mockResolvedValue({ status: 'not_found' });
    const res = await callPost({ action: 'setActive', areaId: 'foreign-area' });
    expect(res.status).toBe(404);
  });

  it('returns 400 for a missing/unknown action', async () => {
    expect((await callPost({})).status).toBe(400);
    expect((await callPost({ action: 'nope' })).status).toBe(400);
  });

  it('returns 401 signed-out and never resolves a family', async () => {
    authMock.mockResolvedValue(null);
    const res = await callPost({ action: 'add', city: 'Toronto' });
    expect(res.status).toBe(401);
    expect(familyMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/mobile/village/areas/search', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset().mockResolvedValue({ user: { id: 'ext-1' } });
    searchMock.mockReset().mockResolvedValue([{ city: 'Toronto', province: 'ON' }]);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('returns 401 for a signed-out caller and never searches', async () => {
    authMock.mockResolvedValue(null);
    const res = await callSearch('http://localhost/api/mobile/village/areas/search?q=tor');
    expect(res.status).toBe(401);
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('returns up to 6 coarse city candidates for the query', async () => {
    const res = await callSearch('http://localhost/api/mobile/village/areas/search?q=toron');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cities: [{ city: 'Toronto', province: 'ON' }] });
    expect(searchMock).toHaveBeenCalledWith('toron');
  });

  it('passes an empty query through (the lib returns [])', async () => {
    searchMock.mockResolvedValue([]);
    const res = await callSearch('http://localhost/api/mobile/village/areas/search');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ cities: [] });
    expect(searchMock).toHaveBeenCalledWith('');
  });
});
