import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile Family route mirrors the web family page: the parent members and the
// editable basics (children + location + plan tier). Both loaders own the DB.
const authMock = vi.fn();
const loadFamilyMembersMock = vi.fn();
const loadFamilyBasicsMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/dashboard/queries', () => ({
  loadFamilyMembers: () => loadFamilyMembersMock(),
  loadFamilyBasics: () => loadFamilyBasicsMock(),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile family route must NOT touch the database (rule #1)');
    },
  };
});

const MEMBERS = {
  primary: { name: 'Ada', email: 'ada@hale.test', role: 'primary_parent' },
  coParent: null,
};
const BASICS = {
  location: { country: 'CA', province: 'ON', city: 'Toronto', postalCode: 'M5V' },
  planTier: 'free',
  intents: [],
  children: [{ id: 'child-1', name: 'Nadia', dateOfBirth: '2024-01-01', stageLabel: 'toddler' }],
};

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/family/route');
  return GET();
}

describe('GET /api/mobile/family', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadFamilyMembersMock.mockReset();
    loadFamilyBasicsMock.mockReset();
    loadFamilyMembersMock.mockResolvedValue(MEMBERS);
    loadFamilyBasicsMock.mockResolvedValue(BASICS);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never calls the loaders', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(loadFamilyMembersMock).not.toHaveBeenCalled();
    expect(loadFamilyBasicsMock).not.toHaveBeenCalled();
  });

  it('returns members, basics, and the viewer (from THIS session) for a signed-in parent', async () => {
    authMock.mockResolvedValue({
      user: { id: 'ext-1', name: 'Beckett', email: 'beckett@hale.test' },
    });

    const res = await callGet();

    expect(res.status).toBe(200);
    // The viewer identifies THIS account, not members.primary — the More profile
    // header would read wrong for a co-parent otherwise.
    expect(await res.json()).toEqual({
      members: MEMBERS,
      basics: BASICS,
      viewer: { name: 'Beckett', email: 'beckett@hale.test' },
    });
    expect(loadFamilyMembersMock).toHaveBeenCalledTimes(1);
    expect(loadFamilyBasicsMock).toHaveBeenCalledTimes(1);
  });
});
