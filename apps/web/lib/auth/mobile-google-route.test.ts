import { errors } from 'jose';
import { getToken } from 'next-auth/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route delegates the security-critical work to verifyGoogleIdToken (covered
// directly in google-id-token.test); here we stub it to exercise the route's
// mapping: a verified identity → a minted session token, a jose failure → 401.
const verifyMock = vi.fn();
const rateLimitedMock = vi.fn();
vi.mock('~/lib/auth/google-id-token', () => ({
  verifyGoogleIdToken: (...args: unknown[]) => verifyMock(...args),
}));
vi.mock('~/lib/auth/rate-limit', () => ({
  authRateLimited: () => rateLimitedMock(),
}));

// Poison the DB connection factory (repo convention, rule #1): this route must
// never construct a database handle regardless of env. Spread importActual so real
// schema/types still resolve; only createDb throws.
vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile google route must NOT touch the database (rule #1)');
    },
  };
});

const TEST_SECRET = 'test-auth-secret-mobile-google-route-0123456789ab';

// From auth.config.ts:27-28: a Google login's token.sub is the OAuth account id
// (providerAccountId == the id_token's `sub`). Derived from that contract.
const GOOGLE_SUB = 'google-oauth-sub-777';
const GOOGLE_EMAIL = 'parent@gmail.com';

async function callPost(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/auth/google/route');
  return POST(
    new Request('http://localhost/api/mobile/auth/google', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/mobile/auth/google', () => {
  beforeEach(() => {
    vi.resetModules();
    verifyMock.mockReset();
    rateLimitedMock.mockReset();
    rateLimitedMock.mockResolvedValue(false);
    vi.stubEnv('AUTH_SECRET', TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 400 when idToken is missing', async () => {
    const res = await callPost({});

    expect(res.status).toBe(400);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-IP rate limit is tripped, without verifying the token', async () => {
    rateLimitedMock.mockResolvedValue(true);

    const res = await callPost({ idToken: 'a.b.c' });

    expect(res.status).toBe(429);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('returns 200 with a token that round-trips to the Google sub', async () => {
    verifyMock.mockResolvedValue({ sub: GOOGLE_SUB, email: GOOGLE_EMAIL });

    const res = await callPost({ idToken: 'a.b.c' }, { 'x-forwarded-proto': 'https' });

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };

    const decoded = await getToken({
      req: new Request('https://x/api/anything', {
        headers: { authorization: `Bearer ${token}` },
      }),
      secret: TEST_SECRET,
      secureCookie: true,
    });

    expect(decoded?.sub).toBe(GOOGLE_SUB);
    expect(decoded?.email).toBe(GOOGLE_EMAIL);
  });

  it('returns 401 with a generic body when verification throws a jose error', async () => {
    verifyMock.mockRejectedValue(new errors.JWTExpired('token expired', {}));

    const res = await callPost({ idToken: 'a.b.c' });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  it('does not swallow a programming error (non-jose) as a 401', async () => {
    verifyMock.mockRejectedValue(new TypeError('bug: undefined is not a function'));

    await expect(callPost({ idToken: 'a.b.c' })).rejects.toThrow('bug:');
  });
});
