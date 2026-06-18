import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads the Auth.js session + db at request time. We stub those edges
// so the test exercises the route's auth gating (mirrors the accept route, hard
// rule #4) and link building, not the real infra. The token + audit logic is
// covered in share.test.
const authMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: vi.fn(),
  resolveUserIdForUser: vi.fn(),
}));
vi.mock('~/lib/village/share', () => ({ ensureShareToken: vi.fn() }));

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

function session(externalAuthId: string | null) {
  return externalAuthId ? { user: { id: externalAuthId } } : null;
}

async function callShare() {
  const { POST } = await import('~/app/api/village/share/route');
  return POST(new Request('http://localhost/api/village/share', { method: 'POST' }));
}

describe('POST /api/village/share — auth gating + link building', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 501 when auth is unconfigured — never shares unauthenticated', async () => {
    configureAuth(false);

    const res = await callShare();

    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
  });

  it('returns 401 when configured but the caller is not signed in', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session(null));

    const res = await callShare();

    expect(res.status).toBe(401);
  });

  it('returns 403 when the signed-in caller is not a member of any family', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google_1'));
    const { resolveFamilyForUser } = await import('~/lib/family');
    vi.mocked(resolveFamilyForUser).mockResolvedValue(null);

    const res = await callShare();

    expect(res.status).toBe(403);
  });

  it('returns 404 when the family has no week plan to share', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google_1'));
    const { resolveFamilyForUser, resolveUserIdForUser } = await import('~/lib/family');
    vi.mocked(resolveFamilyForUser).mockResolvedValue('fam_1');
    vi.mocked(resolveUserIdForUser).mockResolvedValue('user_1');
    const { ensureShareToken } = await import('~/lib/village/share');
    vi.mocked(ensureShareToken).mockResolvedValue(null);

    const res = await callShare();

    expect(res.status).toBe(404);
  });

  it('returns 200 with a /w/:token link built from APP_URL', async () => {
    configureAuth(true);
    vi.stubEnv('APP_URL', 'https://villagehale.com');
    authMock.mockResolvedValue(session('google_1'));
    const { resolveFamilyForUser, resolveUserIdForUser } = await import('~/lib/family');
    vi.mocked(resolveFamilyForUser).mockResolvedValue('fam_1');
    vi.mocked(resolveUserIdForUser).mockResolvedValue('user_1');
    const { ensureShareToken } = await import('~/lib/village/share');
    vi.mocked(ensureShareToken).mockResolvedValue({ shareToken: 'tok123' });

    const res = await callShare();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ link: 'https://villagehale.com/w/tok123' });
  });
});
