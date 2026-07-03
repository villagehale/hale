import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/rights/export — the auth-gated, family-scoped data export (PIPEDA/Law 25
 * right-to-access + portability). Auth is the gate (mirrors the share route): dev-
 * preview 501, signed-out 401, no-family/no-user 403. On success it calls the
 * AUDITED assembler (assembleFamilyExport) and returns the document as a JSON file
 * download — proving the affordance is wired to the audited, teen-redacted path.
 */

const authMock = vi.fn();
const resolveFamilyMock = vi.fn();
const resolveUserIdMock = vi.fn();
const assembleMock = vi.fn();
const DB_HANDLE = { __db: true };

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => DB_HANDLE }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
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
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
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
    resolveFamilyMock.mockReset();
    resolveUserIdMock.mockReset();
    assembleMock.mockReset();
    resolveFamilyMock.mockResolvedValue('fam-1');
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
    resolveFamilyMock.mockResolvedValue(null);
    const res = await callExport();
    expect(res.status).toBe(403);
    expect(assembleMock).not.toHaveBeenCalled();
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
