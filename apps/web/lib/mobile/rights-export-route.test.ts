import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile export route only gates (auth) + resolves the family, then delegates
// to the SAME assembleFamilyExport lib the web /api/rights/export route uses — the
// lib owns the teen redaction and the immutable audit write (rules #1/#6). We mock
// the assembler to assert the exact delegation + status ladder, and poison createDb
// to prove the route never constructs its own db (rule #1).
const authMock = vi.fn();
const currentFamilyIdMock = vi.fn();
const resolveUserIdMock = vi.fn();
const assembleMock = vi.fn();
const DB_HANDLE = { __db: true };

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => DB_HANDLE }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: (...a: unknown[]) => currentFamilyIdMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));
vi.mock('~/lib/rights/export', () => ({
  assembleFamilyExport: (...a: unknown[]) => assembleMock(...a),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile rights export route must NOT construct its own db (rule #1)');
    },
  };
});

const FAMILY_ID = 'fam-1';
const ACTOR_ID = 'user-1';

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/rights/export/route');
  return GET();
}

describe('GET /api/mobile/rights/export', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    currentFamilyIdMock.mockReset();
    resolveUserIdMock.mockReset();
    assembleMock.mockReset();
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    currentFamilyIdMock.mockResolvedValue(FAMILY_ID);
    resolveUserIdMock.mockResolvedValue(ACTOR_ID);
    assembleMock.mockResolvedValue({ exportedAt: '2026-07-09T00:00:00.000Z' });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 503 with no DATABASE_URL and never resolves a family or assembles', async () => {
    vi.stubEnv('DATABASE_URL', '');
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet();

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'no_database' });
    expect(currentFamilyIdMock).not.toHaveBeenCalled();
    expect(assembleMock).not.toHaveBeenCalled();
  });

  it('returns 401 for a signed-out caller and never assembles', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(assembleMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the signed-in user has no family and never assembles', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    currentFamilyIdMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'no_family_for_user' });
    expect(assembleMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the family resolves but the acting user does not', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    resolveUserIdMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(403);
    expect(assembleMock).not.toHaveBeenCalled();
  });

  it('delegates to assembleFamilyExport with the shared db + actor, and returns the document as 200 JSON', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    const document = { exportedAt: '2026-07-09T00:00:00.000Z', family: { id: FAMILY_ID } };
    assembleMock.mockResolvedValue(document);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(document);
    // The route passes the SHARED request-scoped db (not one it built) + the resolved
    // actor, so the lib owns the audit write against the same handle (rules #1/#6).
    expect(assembleMock).toHaveBeenCalledWith(DB_HANDLE, FAMILY_ID, { actorUserId: ACTOR_ID });
    expect(resolveUserIdMock).toHaveBeenCalledWith('ext-1', DB_HANDLE);
  });
});
