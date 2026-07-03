import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/teen-content-grant — the request-access affordance's server side (rule
 * #1 named exception). Auth is the gate: dev-preview 501, signed-out 401, no-family
 * 403, nothing-to-unlock 404. On a valid teen row it calls the AUDITED writer
 * (requestTeenContentAccess) and returns 202 — proving the affordance is wired to
 * the audited grant-request path, never a decision on invisible content.
 */

const authMock = vi.fn();
const resolveFamilyMock = vi.fn();
const resolveUserIdMock = vi.fn();
const resolveTeenChildMock = vi.fn();
const requestAccessMock = vi.fn();
const DB_HANDLE = { __db: true };

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => DB_HANDLE }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));
vi.mock('~/lib/teen-access', () => ({
  resolveActionTeenChild: (...a: unknown[]) => resolveTeenChildMock(...a),
  requestTeenContentAccess: (...a: unknown[]) => requestAccessMock(...a),
}));

const ACTION_ID = '44444444-4444-4444-8444-444444444444';
const TEEN_ID = '33333333-3333-4333-8333-333333333333';

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

async function callPost(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/teen-content-grant/route');
  return POST(
    new Request('http://localhost/api/teen-content-grant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/teen-content-grant', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    resolveFamilyMock.mockReset();
    resolveUserIdMock.mockReset();
    resolveTeenChildMock.mockReset();
    requestAccessMock.mockReset();
    configureAuth(true);
    resolveFamilyMock.mockResolvedValue('fam-1');
    resolveUserIdMock.mockResolvedValue('user-1');
    resolveTeenChildMock.mockResolvedValue(TEEN_ID);
    requestAccessMock.mockResolvedValue({ consentId: 'consent-1' });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('refuses with 501 when auth is unconfigured (never writes a grant)', async () => {
    configureAuth(false);
    const res = await callPost({ actionId: ACTION_ID });
    expect(res.status).toBe(501);
    expect(requestAccessMock).not.toHaveBeenCalled();
  });

  it('refuses with 401 when signed out', async () => {
    authMock.mockResolvedValue(null);
    const res = await callPost({ actionId: ACTION_ID });
    expect(res.status).toBe(401);
    expect(requestAccessMock).not.toHaveBeenCalled();
  });

  it('returns 404 when the action has no teen content to unlock (never writes)', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    resolveTeenChildMock.mockResolvedValue(null);
    const res = await callPost({ actionId: ACTION_ID });
    expect(res.status).toBe(404);
    expect(requestAccessMock).not.toHaveBeenCalled();
  });

  it('calls the audited writer with the resolved family/parent/teen/action and returns 202', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    const res = await callPost({ actionId: ACTION_ID });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'requested', consentId: 'consent-1' });
    expect(requestAccessMock).toHaveBeenCalledWith(DB_HANDLE, {
      familyId: 'fam-1',
      parentUserId: 'user-1',
      teenChildId: TEEN_ID,
      actionId: ACTION_ID,
    });
  });
});
