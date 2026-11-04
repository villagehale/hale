import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/rights/export — the auth-gated, family-scoped data export (PIPEDA/Law 25
 * right-to-access + portability). Auth is the gate (mirrors the share route): dev-
 * preview 501, signed-out 401, no-family/no-user 403. On success it calls the
 * AUDITED assembler (assembleFamilyExport) and returns the document as a JSON file
 * download — proving the affordance is wired to the audited, teen-redacted path.
 *
 * The document is the WHOLE family's record, so only a parent seat of that family gets
 * it: every other seat is refused by name, and a parent of two households is refused
 * rather than handed whichever one a `limit(1)` happened to return.
 */

const authMock = vi.fn();
const listSeatsMock = vi.fn();
const resolveUserIdMock = vi.fn();
const assembleMock = vi.fn();
const DB_HANDLE = { __db: true };

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => DB_HANDLE }));
vi.mock('~/lib/family', () => ({
  listSeatsForUser: (...a: unknown[]) => listSeatsMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));
vi.mock('./export', () => ({
  assembleFamilyExport: (...a: unknown[]) => assembleMock(...a),
}));

const EXPORT_DOC = {
  exportedAt: '2026-07-03T00:00:00.000Z',
  family: { id: 'fam-1', displayName: 'The Rivera Family' },
  children: [],
  members: { primary: null, coParent: null },
  trail: [],
};

function configureAuth(on: boolean) {
  // authConfigured() is AUTH_SECRET. '' is falsy → unconfigured.
  vi.stubEnv('AUTH_SECRET', on ? 'test-auth-secret' : '');
}

function session(externalAuthId: string | null) {
  return externalAuthId ? { user: { id: externalAuthId } } : null;
}

async function callExport(): Promise<Response> {
  const { GET } = await import('~/app/api/rights/export/route');
  return GET(new Request('http://localhost/api/rights/export'));
}

describe('GET /api/rights/export', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    listSeatsMock.mockReset();
    resolveUserIdMock.mockReset();
    assembleMock.mockReset();
    listSeatsMock.mockResolvedValue([{ familyId: 'fam-1', role: 'primary_parent' }]);
    resolveUserIdMock.mockResolvedValue('user-1');
    assembleMock.mockResolvedValue(EXPORT_DOC);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 501 when auth is unconfigured — never exports unauthenticated', async () => {
    configureAuth(false);
    const res = await callExport();
    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
    expect(assembleMock).not.toHaveBeenCalled();
  });

  it('returns 401 when signed out', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session(null));
    const res = await callExport();
    expect(res.status).toBe(401);
    expect(assembleMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller belongs to no family', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google_1'));
    listSeatsMock.mockResolvedValue([]);
    const res = await callExport();
    expect(res.status).toBe(403);
    expect(assembleMock).not.toHaveBeenCalled();
  });

  it('reads the seats of the signed-in user, by their internal id', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google_1'));
    await callExport();
    expect(resolveUserIdMock).toHaveBeenCalledWith('google_1', DB_HANDLE);
    expect(listSeatsMock).toHaveBeenCalledWith('user-1', DB_HANDLE);
  });

  for (const role of ['nanny', 'grandparent', 'babysitter', 'extended', 'service']) {
    it(`refuses the ${role} seat by name and never assembles the family's record`, async () => {
      configureAuth(true);
      authMock.mockResolvedValue(session('google_1'));
      listSeatsMock.mockResolvedValue([{ familyId: 'fam-1', role }]);
      const res = await callExport();

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'export_parent_only' });
      expect(assembleMock).not.toHaveBeenCalled();
    });
  }

  it('exports for a co-parent seat too', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google_1'));
    listSeatsMock.mockResolvedValue([{ familyId: 'fam-1', role: 'co_parent' }]);
    const res = await callExport();

    expect(res.status).toBe(200);
    expect(assembleMock).toHaveBeenCalledWith(DB_HANDLE, 'fam-1', { actorUserId: 'user-1' });
  });

  it('exports the one family a user parents, never the one they only help in', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google_1'));
    listSeatsMock.mockResolvedValue([
      { familyId: 'fam-a', role: 'nanny' },
      { familyId: 'fam-b', role: 'primary_parent' },
    ]);
    const res = await callExport();

    expect(res.status).toBe(200);
    expect(assembleMock).toHaveBeenCalledTimes(1);
    expect(assembleMock).toHaveBeenCalledWith(DB_HANDLE, 'fam-b', { actorUserId: 'user-1' });
  });

  it('refuses a parent of two families by name rather than picking one', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google_1'));
    listSeatsMock.mockResolvedValue([
      { familyId: 'fam-a', role: 'primary_parent' },
      { familyId: 'fam-b', role: 'co_parent' },
    ]);
    const res = await callExport();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'export_family_ambiguous' });
    expect(assembleMock).not.toHaveBeenCalled();
  });

  it('logs a refusal with its outcome and the seat roles only', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google_1'));
    listSeatsMock.mockResolvedValue([{ familyId: 'fam-1', role: 'nanny' }]);
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await callExport();

    expect(info).toHaveBeenCalledWith(
      { outcome: 'export_parent_only', roles: ['nanny'] },
      'rights/export: refused',
    );
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain('fam-1');
    expect(logged).not.toContain('user-1');
    expect(logged).not.toContain('google_1');
    info.mockRestore();
  });

  it('calls the audited assembler with the resolved family + actor and returns the JSON download', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google_1'));
    const res = await callExport();

    expect(res.status).toBe(200);
    expect(assembleMock).toHaveBeenCalledWith(DB_HANDLE, 'fam-1', { actorUserId: 'user-1' });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(await res.json()).toEqual(EXPORT_DOC);
  });
});
