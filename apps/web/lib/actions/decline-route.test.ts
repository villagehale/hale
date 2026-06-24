import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads the Auth.js session + db at request time. We stub those edges
// so the test exercises the route's auth/consent gating (rule #4) — declining a
// draft is still a write, so an unauthenticated caller must never reach it. The
// pure precondition/audit logic is covered in decline.test.
const authMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

const VALID_ID = '33333333-3333-4333-8333-333333333333';

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function callPost(id: string) {
  const { POST } = await import('~/app/api/actions/[id]/decline/route');
  return POST(new Request('http://localhost/api/actions/x/decline', { method: 'POST' }), ctx(id));
}

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

describe('POST /api/actions/:id/decline — auth gating', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 501 when auth is unconfigured — never declines unauthenticated', async () => {
    configureAuth(false);

    const res = await callPost(VALID_ID);

    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-uuid action id before any auth work', async () => {
    configureAuth(true);

    const res = await callPost('not-a-uuid');

    expect(res.status).toBe(400);
    expect(authMock).not.toHaveBeenCalled();
  });

  it('returns 401 when auth is configured but the caller is not signed in', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(null);

    const res = await callPost(VALID_ID);

    expect(res.status).toBe(401);
  });
});
