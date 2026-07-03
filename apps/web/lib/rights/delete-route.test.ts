import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/rights/delete — the confirm-gated account/family deletion REQUEST
 * (PIPEDA/Law 25 right-to-erasure). Auth mirrors the share route: dev-preview 501,
 * signed-out 401, no-family/no-user 403. A request MISSING the confirmation is 400
 * (nothing scheduled). A confirmed request calls the AUDITED scheduler (which
 * SCHEDULES, never hard-deletes) and returns 202 with the effective deletion date.
 */

const authMock = vi.fn();
const resolveFamilyMock = vi.fn();
const resolveUserIdMock = vi.fn();
const scheduleMock = vi.fn();
const DB_HANDLE = { __db: true };
const SCHEDULED_AT = new Date('2026-07-10T12:00:00.000Z');

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => DB_HANDLE }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));
vi.mock('./delete', () => ({
  scheduleFamilyDeletion: (...a: unknown[]) => scheduleMock(...a),
}));

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

function session(externalAuthId: string | null) {
  return externalAuthId ? { user: { id: externalAuthId } } : null;
}

async function callDelete(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/rights/delete/route');
  return POST(
    new Request('http://localhost/api/rights/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/rights/delete', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    resolveFamilyMock.mockReset();
    resolveUserIdMock.mockReset();
    scheduleMock.mockReset();
    configureAuth(true);
    authMock.mockResolvedValue(session('google_1'));
    resolveFamilyMock.mockResolvedValue('fam-1');
    resolveUserIdMock.mockResolvedValue('user-1');
    scheduleMock.mockResolvedValue({ scheduledDeletionAt: SCHEDULED_AT });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 501 when auth is unconfigured — never schedules unauthenticated', async () => {
    configureAuth(false);
    const res = await callDelete({ confirm: true });
    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('returns 401 when signed out', async () => {
    authMock.mockResolvedValue(session(null));
    const res = await callDelete({ confirm: true });
    expect(res.status).toBe(401);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller belongs to no family', async () => {
    resolveFamilyMock.mockResolvedValue(null);
    const res = await callDelete({ confirm: true });
    expect(res.status).toBe(403);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('is confirm-gated: a request without confirm:true is 400 and NEVER schedules', async () => {
    const res = await callDelete({ confirm: false });
    expect(res.status).toBe(400);
    expect(scheduleMock).not.toHaveBeenCalled();
  });

  it('a confirmed request calls the audited scheduler and returns 202 with the deletion date', async () => {
    const res = await callDelete({ confirm: true });
    expect(res.status).toBe(202);
    expect(scheduleMock).toHaveBeenCalledWith(DB_HANDLE, {
      familyId: 'fam-1',
      actorUserId: 'user-1',
    });
    expect(await res.json()).toEqual({
      status: 'scheduled',
      scheduledDeletionAt: SCHEDULED_AT.toISOString(),
    });
  });
});
