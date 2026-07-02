import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile Plan route returns the SAME server-side projection the web plan page
// computes: addedActivities = accepted, non-teen candidates; routine = village
// routine; childItems = planChildItems(companion views); hasPlan derived from all
// three. planChildItems is the real pure fn (mocked here to assert the route hands
// it the loaded companion views), the filter is the route's own logic (tested with
// real candidate rows so the accepted/teen filter is exercised).
const authMock = vi.fn();
const loadVillageMock = vi.fn();
const loadCompanionMock = vi.fn();
const planChildItemsMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/village/queries', () => ({ loadVillage: () => loadVillageMock() }));
vi.mock('~/lib/companion/queries', () => ({ loadCompanion: () => loadCompanionMock() }));
vi.mock('~/lib/plan/week', () => ({
  planChildItems: (...a: unknown[]) => planChildItemsMock(...a),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile plan route must NOT touch the database (rule #1)');
    },
  };
});

const ACCEPTED = { id: 'cand-accepted', accepted: true, teenAttributed: false, title: 'Storytime' };
const ACCEPTED_TEEN = {
  id: 'cand-teen',
  accepted: true,
  teenAttributed: true,
  title: '[redacted]',
};
const NOT_ACCEPTED = { id: 'cand-open', accepted: false, teenAttributed: false, title: 'Swim' };
const ROUTINE = {
  id: 'routine-1',
  weekOf: '2026-06-29',
  items: [{ title: 'a', kind: 'b', stageNote: 'c', teenAttributed: false }],
};
const CHILDREN = [{ id: 'child-1', name: 'Nadia' }];
const CHILD_ITEMS = [
  {
    key: 'child-1-health',
    childName: 'Nadia',
    kindLabel: 'checkup',
    what: '18-month visit',
    when: 'this week',
  },
];

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/plan/route');
  return GET();
}

describe('GET /api/mobile/plan', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadVillageMock.mockReset();
    loadCompanionMock.mockReset();
    planChildItemsMock.mockReset();
    loadVillageMock.mockResolvedValue({
      candidates: [ACCEPTED, ACCEPTED_TEEN, NOT_ACCEPTED],
      routine: ROUTINE,
    });
    loadCompanionMock.mockResolvedValue(CHILDREN);
    planChildItemsMock.mockReturnValue(CHILD_ITEMS);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never calls the loaders', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(loadVillageMock).not.toHaveBeenCalled();
    expect(loadCompanionMock).not.toHaveBeenCalled();
  });

  it('projects accepted non-teen activities, routine, and child items with hasPlan', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      addedActivities: [ACCEPTED],
      routine: ROUTINE,
      childItems: CHILD_ITEMS,
      hasPlan: true,
    });
    expect(planChildItemsMock).toHaveBeenCalledWith(CHILDREN);
  });

  it('reports hasPlan=false when there is no routine, no accepted activity, and no child items', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    loadVillageMock.mockResolvedValue({ candidates: [NOT_ACCEPTED, ACCEPTED_TEEN], routine: null });
    planChildItemsMock.mockReturnValue([]);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      addedActivities: [],
      routine: null,
      childItems: [],
      hasPlan: false,
    });
  });
});
