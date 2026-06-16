import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads Clerk auth + db + queue at request time. We stub those edges
// so the test exercises the route's auth/consent gating (hard rule #4), not the
// real infra. The pure precondition logic is covered separately in accept.test.
const authMock = vi.fn();
vi.mock('@clerk/nextjs/server', () => ({ auth: () => authMock() }));
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

function configureClerk(on: boolean) {
  // clerkConfigured() reads truthiness; '' is falsy → unconfigured.
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', on ? 'pk_test' : '');
  vi.stubEnv('CLERK_SECRET_KEY', on ? 'sk_test' : '');
}

describe('POST /api/village/:id/accept — auth gating', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 501 when Clerk is unconfigured — never accepts unauthenticated', async () => {
    configureClerk(false);

    const res = await callPost(VALID_ID);

    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-uuid candidate id before any auth work', async () => {
    configureClerk(true);

    const res = await callPost('not-a-uuid');

    expect(res.status).toBe(400);
    expect(authMock).not.toHaveBeenCalled();
  });

  it('returns 401 when Clerk is configured but the caller is not signed in', async () => {
    configureClerk(true);
    authMock.mockResolvedValue({ userId: null });

    const res = await callPost(VALID_ID);

    expect(res.status).toBe(401);
  });
});
