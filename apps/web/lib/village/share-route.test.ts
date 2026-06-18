import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads Clerk auth + db at request time. We stub those edges so the
// test exercises the route's auth gating (mirrors the accept route, hard rule
// #4) and link building, not the real infra. The token + audit logic is covered
// in share.test.
const authMock = vi.fn();
vi.mock('@clerk/nextjs/server', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForClerkUser: vi.fn(),
  resolveUserIdForClerkUser: vi.fn(),
}));
vi.mock('~/lib/village/share', () => ({ ensureShareToken: vi.fn() }));

function configureClerk(on: boolean) {
  vi.stubEnv('NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY', on ? 'pk_test' : '');
  vi.stubEnv('CLERK_SECRET_KEY', on ? 'sk_test' : '');
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

  it('returns 501 when Clerk is unconfigured — never shares unauthenticated', async () => {
    configureClerk(false);

    const res = await callShare();

    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
  });

  it('returns 401 when configured but the caller is not signed in', async () => {
    configureClerk(true);
    authMock.mockResolvedValue({ userId: null });

    const res = await callShare();

    expect(res.status).toBe(401);
  });

  it('returns 403 when the signed-in caller is not a member of any family', async () => {
    configureClerk(true);
    authMock.mockResolvedValue({ userId: 'clerk_1' });
    const { resolveFamilyForClerkUser } = await import('~/lib/family');
    vi.mocked(resolveFamilyForClerkUser).mockResolvedValue(null);

    const res = await callShare();

    expect(res.status).toBe(403);
  });

  it('returns 404 when the family has no week plan to share', async () => {
    configureClerk(true);
    authMock.mockResolvedValue({ userId: 'clerk_1' });
    const { resolveFamilyForClerkUser, resolveUserIdForClerkUser } = await import('~/lib/family');
    vi.mocked(resolveFamilyForClerkUser).mockResolvedValue('fam_1');
    vi.mocked(resolveUserIdForClerkUser).mockResolvedValue('user_1');
    const { ensureShareToken } = await import('~/lib/village/share');
    vi.mocked(ensureShareToken).mockResolvedValue(null);

    const res = await callShare();

    expect(res.status).toBe(404);
  });

  it('returns 200 with a /w/:token link built from APP_URL', async () => {
    configureClerk(true);
    vi.stubEnv('APP_URL', 'https://villagehale.com');
    authMock.mockResolvedValue({ userId: 'clerk_1' });
    const { resolveFamilyForClerkUser, resolveUserIdForClerkUser } = await import('~/lib/family');
    vi.mocked(resolveFamilyForClerkUser).mockResolvedValue('fam_1');
    vi.mocked(resolveUserIdForClerkUser).mockResolvedValue('user_1');
    const { ensureShareToken } = await import('~/lib/village/share');
    vi.mocked(ensureShareToken).mockResolvedValue({ shareToken: 'tok123' });

    const res = await callShare();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ link: 'https://villagehale.com/w/tok123' });
  });
});
