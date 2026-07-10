import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile shared-links routes only gate (auth) + resolve the family, then delegate
// to the SAME listSharedLinks / revokeShareLink libs the web /api/village/shares
// routes use — the libs own the family scoping + the immutable revoke audit (rules
// #1/#6). We mock the libs to assert the exact delegation + status ladder, and poison
// createDb to prove neither route constructs its own db (rule #1).
const authMock = vi.fn();
const currentFamilyIdMock = vi.fn();
const resolveUserIdMock = vi.fn();
const listMock = vi.fn();
const revokeMock = vi.fn();
const DB_HANDLE = { __db: true };

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => DB_HANDLE }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: (...a: unknown[]) => currentFamilyIdMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));
vi.mock('~/lib/village/share-revoke', () => ({
  listSharedLinks: (...a: unknown[]) => listMock(...a),
  revokeShareLink: (...a: unknown[]) => revokeMock(...a),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile village shares route must NOT construct its own db (rule #1)');
    },
  };
});

const FAMILY_ID = 'fam-1';
const ACTOR_ID = 'user-1';
const LINK_ID = '11111111-1111-1111-1111-111111111111';

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/village/shares/route');
  return GET();
}

async function callRevoke(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/village/shares/revoke/route');
  return POST(
    new Request('http://localhost/api/mobile/village/shares/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

function resetAll() {
  vi.resetModules();
  authMock.mockReset();
  currentFamilyIdMock.mockReset();
  resolveUserIdMock.mockReset();
  listMock.mockReset();
  revokeMock.mockReset();
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  currentFamilyIdMock.mockResolvedValue(FAMILY_ID);
  resolveUserIdMock.mockResolvedValue(ACTOR_ID);
  listMock.mockResolvedValue([]);
  revokeMock.mockResolvedValue(true);
}

describe('GET /api/mobile/village/shares', () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 503 with no DATABASE_URL and never lists', async () => {
    vi.stubEnv('DATABASE_URL', '');
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'no_database' });
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns 401 for a signed-out caller and never lists', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the signed-in user has no family and never lists', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    currentFamilyIdMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(403);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('delegates to listSharedLinks with the shared db + family and returns the links as 200', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    const links = [{ kind: 'activity', id: LINK_ID, token: 'tok', title: 'A local pick' }];
    listMock.mockResolvedValue(links);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ links });
    expect(listMock).toHaveBeenCalledWith(DB_HANDLE, FAMILY_ID);
  });
});

describe('POST /api/mobile/village/shares/revoke', () => {
  beforeEach(resetAll);
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 503 with no DATABASE_URL and never revokes', async () => {
    vi.stubEnv('DATABASE_URL', '');
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callRevoke({ kind: 'activity', id: LINK_ID });

    expect(res.status).toBe(503);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('returns 401 for a signed-out caller and never revokes', async () => {
    authMock.mockResolvedValue(null);

    const res = await callRevoke({ kind: 'activity', id: LINK_ID });

    expect(res.status).toBe(401);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a malformed body (bad kind) and never revokes', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callRevoke({ kind: 'nonsense', id: LINK_ID });

    expect(res.status).toBe(400);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-uuid id and never revokes', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callRevoke({ kind: 'activity', id: 'not-a-uuid' });

    expect(res.status).toBe(400);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the signed-in user has no family and never revokes', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    currentFamilyIdMock.mockResolvedValue(null);

    const res = await callRevoke({ kind: 'activity', id: LINK_ID });

    expect(res.status).toBe(403);
    expect(revokeMock).not.toHaveBeenCalled();
  });

  it('delegates to revokeShareLink with the shared db + family + actor and returns 200 on a real revoke', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callRevoke({ kind: 'week_plan', id: LINK_ID });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'revoked' });
    expect(revokeMock).toHaveBeenCalledWith(DB_HANDLE, {
      kind: 'week_plan',
      id: LINK_ID,
      familyId: FAMILY_ID,
      actorUserId: ACTOR_ID,
    });
  });

  it('maps a not-owned / already-gone link (revoke returns false) to 404', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    revokeMock.mockResolvedValue(false);

    const res = await callRevoke({ kind: 'activity', id: LINK_ID });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'link_not_found' });
  });
});
