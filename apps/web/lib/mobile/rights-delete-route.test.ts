import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile delete route only gates (auth) + resolves the family, then delegates
// to the SAME scheduleFamilyDeletion lib the web /api/rights/delete route uses — the
// lib owns the reversible 7-day grace stamp + the immutable audit write (rules #1/#6).
// We mock the scheduler to assert the exact delegation + status ladder, and poison
// createDb to prove the route never constructs its own db (rule #1).
const authMock = vi.fn();
const currentFamilyIdMock = vi.fn();
const resolveUserIdMock = vi.fn();
const scheduleMock = vi.fn();
const DB_HANDLE = { __db: true };

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => DB_HANDLE }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: (...a: unknown[]) => currentFamilyIdMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));
vi.mock('~/lib/rights/delete', () => ({
  scheduleFamilyDeletion: (...a: unknown[]) => scheduleMock(...a),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile rights delete route must NOT construct its own db (rule #1)');
    },
  };
});

const FAMILY_ID = 'fam-1';
const ACTOR_ID = 'user-1';
const SCHEDULED_AT = new Date('2026-07-16T00:00:00.000Z');

async function callPost(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/rights/delete/route');
  return POST(
    new Request('http://localhost/api/mobile/rights/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/mobile/rights/delete', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    currentFamilyIdMock.mockReset();
    resolveUserIdMock.mockReset();
    scheduleMock.mockReset();
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    currentFamilyIdMock.mockResolvedValue(FAMILY_ID);
    resolveUserIdMock.mockResolvedValue(ACTOR_ID);
    scheduleMock.mockResolvedValue({ scheduledDeletionAt: SCHEDULED_AT });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 503 with no DATABASE_URL and never schedules', async () => {
    vi.stubEnv('DATABASE_URL', '');
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ confirm: true });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'no_database' });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('returns 401 for a signed-out caller and never schedules', async () => {
    authMock.mockResolvedValue(null);

    const res = await callPost({ confirm: true });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('returns 400 without confirm:true and never schedules (nothing is deleted by a bare POST)', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({});

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'confirmation_required' });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('returns 400 when confirm is false (a literal-true gate, not a truthy check)', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ confirm: false });

    expect(res.status).toBe(400);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the signed-in user has no family and never schedules', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    currentFamilyIdMock.mockResolvedValue(null);

    const res = await callPost({ confirm: true });

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'no_family_for_user' });
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('schedules via the shared db + actor and returns 202 with the ISO deletion instant', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ confirm: true });

    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({
      status: 'scheduled',
      scheduledDeletionAt: SCHEDULED_AT.toISOString(),
    });
    // The lib gets the SHARED db + resolved actor (it owns the grace stamp + audit).
    expect(scheduleMock).toHaveBeenCalledWith(DB_HANDLE, {
      familyId: FAMILY_ID,
      actorUserId: ACTOR_ID,
    });
  });
});
