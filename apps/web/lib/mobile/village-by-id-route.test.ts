import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile Village-by-id route resolves one candidate through
// loadVillageCandidateById, which redacts a teen-attributed card at the mapper
// (rule #1) and returns null for an unknown / foreign id. The route itself never
// touches the DB — the loader does, behind currentFamilyId.
const authMock = vi.fn();
const loadByIdMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/village/queries', () => ({ loadVillageCandidateById: (id: string) => loadByIdMock(id) }));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile village-by-id route must NOT touch the database directly (rule #1)');
    },
  };
});

const CANDIDATE = { id: '11111111-1111-4111-8111-111111111111', teenAttributed: false, title: 'Storytime' };

async function callGet(id: string): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/village/[id]/route');
  return GET(new Request(`http://localhost/api/mobile/village/${id}`), {
    params: Promise.resolve({ id }),
  });
}

describe('GET /api/mobile/village/:id', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadByIdMock.mockReset();
    loadByIdMock.mockResolvedValue(CANDIDATE);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects a non-uuid id with 400 and never authenticates or reads', async () => {
    const res = await callGet('not-a-uuid');

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(authMock).not.toHaveBeenCalled();
    expect(loadByIdMock).not.toHaveBeenCalled();
  });

  it('returns 401 for a signed-out caller and never reads the candidate', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet(CANDIDATE.id);

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(loadByIdMock).not.toHaveBeenCalled();
  });

  it('returns the resolved candidate for a signed-in parent', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet(CANDIDATE.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidate: CANDIDATE });
    expect(loadByIdMock).toHaveBeenCalledWith(CANDIDATE.id);
  });

  it('returns { candidate: null } for an unknown / foreign id (never reveals existence)', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    loadByIdMock.mockResolvedValue(null);

    const res = await callGet('22222222-2222-4222-8222-222222222222');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ candidate: null });
  });
});
