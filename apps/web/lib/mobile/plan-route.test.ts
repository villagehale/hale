import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile Plan route returns the SAME server-side projection the web plan page
// computes: authoredPlans = the session-scoped parent-authored plans; timeZone =
// the family's IANA zone (so the client builds the same current-week spine);
// addedActivities = accepted, non-teen candidates; routine = village routine;
// childItems = planChildItems(companion views); hasPlan derived from all of it.
// planChildItems is the real pure fn (mocked here to assert the route hands it the
// loaded companion views), the filter is the route's own logic (tested with real
// candidate rows so the accepted/teen filter is exercised).
//
// The POST route only gates (auth) and DISPATCHES to the SAME web server actions
// the browser Plan page calls (createPlan / completePlan / deletePlan) — it owns no
// validation or DB access of its own (rule #1). So we mock those actions to assert
// the delegation + the action-result → HTTP-status mapping, and poison createDb to
// prove the route never constructs a db.
const authMock = vi.fn();
const loadVillageMock = vi.fn();
const loadCompanionMock = vi.fn();
const loadAuthoredPlansMock = vi.fn();
const loadFamilyTimezoneMock = vi.fn();
const readUserPreferencesMock = vi.fn();
const planChildItemsMock = vi.fn();
const createPlanMock = vi.fn();
const completePlanMock = vi.fn();
const deletePlanMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/village/queries', () => ({ loadVillage: () => loadVillageMock() }));
vi.mock('~/lib/companion/queries', () => ({ loadCompanion: () => loadCompanionMock() }));
vi.mock('~/lib/plan/authored', () => ({ loadAuthoredPlans: () => loadAuthoredPlansMock() }));
vi.mock('~/lib/dashboard/queries', () => ({
  loadFamilyTimezone: () => loadFamilyTimezoneMock(),
}));
vi.mock('~/lib/settings/user-preferences', () => ({
  readUserPreferences: () => readUserPreferencesMock(),
}));
vi.mock('~/lib/plan/week', () => ({
  planChildItems: (...a: unknown[]) => planChildItemsMock(...a),
}));
vi.mock('~/lib/plan/plan-actions', () => ({
  createPlan: (...a: unknown[]) => createPlanMock(...a),
  completePlan: (...a: unknown[]) => completePlanMock(...a),
  deletePlan: (...a: unknown[]) => deletePlanMock(...a),
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
const AUTHORED = [
  {
    id: 'plan-1',
    title: 'swim registration',
    notes: null,
    scheduledFor: '2026-07-01T00:00:00.000Z',
    completedAt: null,
    childId: 'child-1',
    childName: 'Nadia',
  },
];

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/plan/route');
  return GET();
}

async function callPost(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/plan/route');
  return POST(
    new Request('http://localhost/api/mobile/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('GET /api/mobile/plan', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadVillageMock.mockReset();
    loadCompanionMock.mockReset();
    loadAuthoredPlansMock.mockReset();
    loadFamilyTimezoneMock.mockReset();
    readUserPreferencesMock.mockReset();
    planChildItemsMock.mockReset();
    loadVillageMock.mockResolvedValue({
      candidates: [ACCEPTED, ACCEPTED_TEEN, NOT_ACCEPTED],
      routine: ROUTINE,
    });
    loadCompanionMock.mockResolvedValue(CHILDREN);
    loadAuthoredPlansMock.mockResolvedValue(AUTHORED);
    loadFamilyTimezoneMock.mockResolvedValue('America/Toronto');
    readUserPreferencesMock.mockResolvedValue({ units: 'metric', weekStartDay: 1 });
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
    expect(loadAuthoredPlansMock).not.toHaveBeenCalled();
  });

  it('projects authored plans, timeZone, accepted non-teen activities, routine, and child items with hasPlan', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authoredPlans: AUTHORED,
      timeZone: 'America/Toronto',
      weekStartDay: 1,
      scopeChildren: [{ id: 'child-1', label: 'Nadia' }],
      addedActivities: [ACCEPTED],
      routine: ROUTINE,
      childItems: CHILD_ITEMS,
      hasPlan: true,
    });
    expect(planChildItemsMock).toHaveBeenCalledWith(CHILDREN);
  });

  it('reports hasPlan=true when the ONLY thing present is an authored plan', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    loadVillageMock.mockResolvedValue({ candidates: [NOT_ACCEPTED, ACCEPTED_TEEN], routine: null });
    planChildItemsMock.mockReturnValue([]);
    loadAuthoredPlansMock.mockResolvedValue(AUTHORED);

    const res = await callGet();

    const body = (await res.json()) as { hasPlan: boolean; authoredPlans: unknown[] };
    expect(body.hasPlan).toBe(true);
    expect(body.authoredPlans).toEqual(AUTHORED);
  });

  it('reports hasPlan=false when there is no routine, no accepted activity, no child items, and no authored plan', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    loadVillageMock.mockResolvedValue({ candidates: [NOT_ACCEPTED, ACCEPTED_TEEN], routine: null });
    planChildItemsMock.mockReturnValue([]);
    loadAuthoredPlansMock.mockResolvedValue([]);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      authoredPlans: [],
      timeZone: 'America/Toronto',
      weekStartDay: 1,
      scopeChildren: [{ id: 'child-1', label: 'Nadia' }],
      addedActivities: [],
      routine: null,
      childItems: [],
      hasPlan: false,
    });
  });
});

describe('POST /api/mobile/plan', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    createPlanMock.mockReset();
    completePlanMock.mockReset();
    deletePlanMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never dispatches', async () => {
    authMock.mockResolvedValue(null);

    const res = await callPost({ action: 'create', title: 'swim', notes: null, scheduledFor: null, childId: null });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(createPlanMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a body with no action', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ title: 'swim' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it('delegates create to createPlan with the full PlanInput and maps created → 200', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    createPlanMock.mockResolvedValue({ status: 'created' });

    const res = await callPost({
      action: 'create',
      title: 'swim registration',
      notes: 'before it fills up',
      scheduledFor: '2026-07-01T00:00:00.000Z',
      childId: 'child-1',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'created' });
    expect(createPlanMock).toHaveBeenCalledWith({
      title: 'swim registration',
      notes: 'before it fills up',
      scheduledFor: '2026-07-01T00:00:00.000Z',
      childId: 'child-1',
    });
  });

  it('surfaces a create validation error code as 400 with the code', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    createPlanMock.mockResolvedValue({ status: 'invalid', error: 'title_required' });

    const res = await callPost({ action: 'create', title: '', notes: null, scheduledFor: null, childId: null });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'title_required' });
  });

  it('returns 400 (never a bare 500) for a create body with a wrong-typed field', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ action: 'create', title: 123, notes: null, scheduledFor: null, childId: null });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(createPlanMock).not.toHaveBeenCalled();
  });

  it('maps a foreign_child create to 400', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    createPlanMock.mockResolvedValue({ status: 'foreign_child' });

    const res = await callPost({
      action: 'create',
      title: 'swim',
      notes: null,
      scheduledFor: null,
      childId: 'not-mine',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'foreign_child' });
  });

  const PLAN_ID = '11111111-1111-4111-8111-111111111111';

  it('delegates complete to completePlan and maps completed → 200', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    completePlanMock.mockResolvedValue({ status: 'completed' });

    const res = await callPost({ action: 'complete', planId: PLAN_ID });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'completed' });
    expect(completePlanMock).toHaveBeenCalledWith(PLAN_ID);
  });

  it('delegates delete to deletePlan and maps deleted → 200', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    deletePlanMock.mockResolvedValue({ status: 'deleted' });

    const res = await callPost({ action: 'delete', planId: PLAN_ID });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'deleted' });
    expect(deletePlanMock).toHaveBeenCalledWith(PLAN_ID);
  });

  // A malformed planId reaches a `uuid` column and throws on the cast (a bare 500 in
  // prod, caught live) — the boundary must reject it as 400 BEFORE the action runs.
  it.each([
    ['empty', ''],
    ['non-uuid', 'not-a-uuid'],
  ])('returns 400 (never a bare 500) for a delete with a %s planId', async (_label, planId) => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ action: 'delete', planId });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
    expect(deletePlanMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a complete with a non-uuid planId and never calls completePlan', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ action: 'complete', planId: 'plan-9' });

    expect(res.status).toBe(400);
    expect(completePlanMock).not.toHaveBeenCalled();
  });

  it('maps an action not_found (valid but unknown uuid) to 404', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    completePlanMock.mockResolvedValue({ status: 'not_found' });

    const res = await callPost({ action: 'complete', planId: PLAN_ID });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('maps a preview outcome (auth unconfigured) to 503', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    createPlanMock.mockResolvedValue({ status: 'preview' });

    const res = await callPost({ action: 'create', title: 'swim', notes: null, scheduledFor: null, childId: null });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'preview' });
  });

  it('returns 400 for an unknown action', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ action: 'bogus' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'unknown_action' });
  });
});
