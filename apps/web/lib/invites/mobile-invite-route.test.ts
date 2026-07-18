import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile invite route is the web /api/invite route's twin at the /api/mobile/*
// path (the app calls it Bearer-authed; the Edge middleware bridges the Bearer token
// to the same Auth.js session `auth()` reads). We stub the same edges the web
// invite-route test stubs so these tests exercise the auth/consent gating (rule #5:
// only a member mints a co-parent invite), not the real infra — the pure store logic
// is covered in invite-store.test.
const authMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: vi.fn(),
  resolveUserIdForUser: vi.fn(),
}));
vi.mock('~/lib/invites/create', () => ({ createFamilyInvite: vi.fn() }));

function session(externalAuthId: string | null, email: string | null = 'avery@example.com') {
  return externalAuthId ? { user: { id: externalAuthId, email, name: 'Avery' } } : null;
}

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

async function callInvite() {
  const { POST } = await import('~/app/api/mobile/invite/route');
  return POST(new Request('http://localhost/api/mobile/invite', { method: 'POST' }));
}

describe('POST /api/mobile/invite — auth + membership gating (rule #5)', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 501 when auth is unconfigured — never invites in the dev preview', async () => {
    configureAuth(false);

    const res = await callInvite();

    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
  });

  it('returns 401 when configured but the caller is not signed in', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session(null));

    const res = await callInvite();

    expect(res.status).toBe(401);
  });

  it('returns 403 when the signed-in caller is not a member of any family', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google_1'));
    const { resolveFamilyForUser } = await import('~/lib/family');
    vi.mocked(resolveFamilyForUser).mockResolvedValue(null);

    const res = await callInvite();

    expect(res.status).toBe(403);
  });

  it('returns 201 with a redeem link built from APP_URL for a member, reusing createFamilyInvite', async () => {
    configureAuth(true);
    vi.stubEnv('APP_URL', 'https://hale.example');
    authMock.mockResolvedValue(session('google_1'));
    const { resolveFamilyForUser, resolveUserIdForUser } = await import('~/lib/family');
    vi.mocked(resolveFamilyForUser).mockResolvedValue('fam_1');
    vi.mocked(resolveUserIdForUser).mockResolvedValue('user_1');
    const { createFamilyInvite } = await import('~/lib/invites/create');
    vi.mocked(createFamilyInvite).mockResolvedValue({ token: 'tok123' });

    const res = await callInvite();

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ link: 'https://hale.example/invite/tok123' });
    // The SAME lib the web route uses — audit + consent semantics preserved, never
    // reimplemented — invoked with the caller's resolved family + user.
    expect(vi.mocked(createFamilyInvite).mock.calls[0]?.[1]).toEqual({
      familyId: 'fam_1',
      creatorUserId: 'user_1',
      email: undefined,
    });
  });
});
