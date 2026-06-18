import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads the Auth.js session + db + queue at request time. We stub those
// edges so the test exercises the route's auth/consent gating (hard rule #4), not
// the real infra. The pure precondition logic is covered separately in accept.test.
const authMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/queue', () => ({ getQueue: async () => ({ send: vi.fn() }) }));

const VALID_ID = '33333333-3333-4333-8333-333333333333';

function ctx(id: string) {
  return { params: Promise.resolve({ id }) };
}

async function callPost(id: string) {
  const { POST } = await import('~/app/api/village/[id]/accept/route');
  return POST(new Request('http://localhost/api/village/x/accept', { method: 'POST' }), ctx(id));
}

function configureAuth(on: boolean) {
  // authConfigured() reads truthiness; '' is falsy → unconfigured.
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

describe('POST /api/village/:id/accept — auth gating', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 501 when auth is unconfigured — never accepts unauthenticated', async () => {
    configureAuth(false);

    const res = await callPost(VALID_ID);

    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-uuid candidate id before any auth work', async () => {
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
