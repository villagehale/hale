import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile Home route composes the SAME loaders the web home page uses; teen
// redaction lives inside those loaders, so the route never touches @hale/db. We
// mock auth() (the 401 gate) and each loader, then assert: signed-out → 401 with
// no loader called; signed-in → every loader called and the JSON is the loaders'
// literal return values.
const authMock = vi.fn();
const loadCompanionMock = vi.fn();
const loadVillageMock = vi.fn();
const loadFamilyMembersMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/companion/queries', () => ({ loadCompanion: () => loadCompanionMock() }));
vi.mock('~/lib/village/queries', () => ({ loadVillage: () => loadVillageMock() }));
vi.mock('~/lib/dashboard/queries', () => ({ loadFamilyMembers: () => loadFamilyMembersMock() }));

// Poison the DB connection factory (repo convention, rule #1): this route must
// never construct a database handle — reads go through the loaders only.
vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile home route must NOT touch the database (rule #1)');
    },
  };
});

const CHILDREN = [{ id: 'child-1', name: 'Nadia', stage: 'toddler' }];
const VILLAGE = { candidates: [{ id: 'cand-1' }], routine: null };
const MEMBERS = {
  primary: { name: 'Ada', email: 'ada@hale.test', role: 'primary_parent' },
  coParent: null,
};

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/home/route');
  return GET();
}

describe('GET /api/mobile/home', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadCompanionMock.mockReset();
    loadVillageMock.mockReset();
    loadFamilyMembersMock.mockReset();
    loadCompanionMock.mockResolvedValue(CHILDREN);
    loadVillageMock.mockResolvedValue(VILLAGE);
    loadFamilyMembersMock.mockResolvedValue(MEMBERS);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never calls the loaders', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(loadCompanionMock).not.toHaveBeenCalled();
    expect(loadVillageMock).not.toHaveBeenCalled();
    expect(loadFamilyMembersMock).not.toHaveBeenCalled();
  });

  it('returns 401 when the session has no user id', async () => {
    authMock.mockResolvedValue({ user: {} });

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(loadCompanionMock).not.toHaveBeenCalled();
  });

  it('returns the composed loader output plus the signed-in viewer', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1', name: 'Jordan Reyes' } });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      children: CHILDREN,
      village: VILLAGE,
      members: MEMBERS,
      viewer: { name: 'Jordan Reyes' },
    });
    expect(loadCompanionMock).toHaveBeenCalledTimes(1);
    expect(loadVillageMock).toHaveBeenCalledTimes(1);
    expect(loadFamilyMembersMock).toHaveBeenCalledTimes(1);
  });

  it('greets by the viewer, not the primary-parent slot, for a co-parent', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-2', name: 'Jordan Reyes' } });

    const res = await callGet();
    const body = (await res.json()) as { members: typeof MEMBERS; viewer: { name: string | null } };

    // members.primary is Ada; the signed-in co-parent is Jordan — greeting must
    // read Jordan (the viewer), never Ada (the primary slot).
    expect(body.members.primary?.name).toBe('Ada');
    expect(body.viewer.name).toBe('Jordan Reyes');
  });
});
