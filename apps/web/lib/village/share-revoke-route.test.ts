import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shared-links routes: GET /api/village/shares (list) and
 * POST /api/village/shares/revoke (revoke). Auth mirrors the share route: dev-
 * preview 501, signed-out 401, no-family/no-user 403. Revoke rejects a malformed
 * body (400) and a link the family doesn't own (404 — the mutation returned false,
 * never a cross-family write). The happy revoke calls the AUDITED mutation.
 */

const authMock = vi.fn();
const resolveFamilyMock = vi.fn();
const resolveUserIdMock = vi.fn();
const listMock = vi.fn();
const revokeMock = vi.fn();
const DB_HANDLE = { __db: true };

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => DB_HANDLE }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));
vi.mock('~/lib/village/share-revoke', () => ({
  listSharedLinks: (...a: unknown[]) => listMock(...a),
  revokeShareLink: (...a: unknown[]) => revokeMock(...a),
}));

const LINK_ID = '22222222-2222-4222-8222-222222222222';

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

function session(externalAuthId: string | null) {
  return externalAuthId ? { user: { id: externalAuthId } } : null;
}

async function callList(): Promise<Response> {
  const { GET } = await import('~/app/api/village/shares/route');
  return GET();
}

async function callRevoke(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/village/shares/revoke/route');
  return POST(
    new Request('http://localhost/api/village/shares/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  authMock.mockReset();
  resolveFamilyMock.mockReset();
  resolveUserIdMock.mockReset();
  listMock.mockReset();
  revokeMock.mockReset();
  configureAuth(true);
  authMock.mockResolvedValue(session('google_1'));
  resolveFamilyMock.mockResolvedValue('fam-1');
  resolveUserIdMock.mockResolvedValue('user-1');
  listMock.mockResolvedValue([]);
  revokeMock.mockResolvedValue(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/village/shares', () => {
  it('returns 501 when auth is unconfigured', async () => {
    configureAuth(false);
    const res = await callList();
    expect(res.status).toBe(501);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns 401 when signed out', async () => {
    authMock.mockResolvedValue(session(null));
    const res = await callList();
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller belongs to no family', async () => {
    resolveFamilyMock.mockResolvedValue(null);
    const res = await callList();
    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns the family-scoped list of shared links', async () => {
    const links = [{ kind: 'week_plan', id: LINK_ID, token: 'tok', title: 'week of 2026-07-06' }];
    listMock.mockResolvedValue(links);
    const res = await callList();
    expect(res.status).toBe(200);
    expect(listMock).toHaveBeenCalledWith(DB_HANDLE, 'fam-1');
    expect(await res.json()).toEqual({ links });
  });
});

describe('POST /api/village/shares/revoke', () => {
  it('returns 501 when auth is unconfigured — never revokes unauthenticated', async () => {
    configureAuth(false);
    const res = await callRevoke({ kind: 'week_plan', id: LINK_ID });
    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('returns 401 when signed out', async () => {
    authMock.mockResolvedValue(session(null));
    const res = await callRevoke({ kind: 'week_plan', id: LINK_ID });
    expect(res.status).toBe(401);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the caller belongs to no family', async () => {
    resolveFamilyMock.mockResolvedValue(null);
    const res = await callRevoke({ kind: 'week_plan', id: LINK_ID });
    expect(res.status).toBe(403);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed body (400) — nothing revoked', async () => {
    const res = await callRevoke({ kind: 'not_a_kind', id: LINK_ID });
    expect(res.status).toBe(400);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('revokes via the audited, family-scoped mutation and returns 200', async () => {
    const res = await callRevoke({ kind: 'activity', id: LINK_ID });
    expect(res.status).toBe(200);
    expect(revokeMock).toHaveBeenCalledWith(DB_HANDLE, {
      kind: 'activity',
      id: LINK_ID,
      familyId: 'fam-1',
      actorUserId: 'user-1',
    });
    expect(await res.json()).toEqual({ status: 'revoked' });
  });

  it('returns 404 when the link is not the family’s (no cross-family write, rule #1)', async () => {
    revokeMock.mockResolvedValue(false);
    const res = await callRevoke({ kind: 'week_plan', id: LINK_ID });
    expect(res.status).toBe(404);
  });
});
