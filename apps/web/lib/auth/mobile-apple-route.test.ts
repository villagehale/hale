import { errors } from 'jose';
import { getToken } from 'next-auth/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route delegates the security-critical work to verifyAppleIdToken (covered
// directly in apple-id-token.test); here we stub it to exercise the route's
// mapping: a verified identity → a minted session token, a jose failure → 401.
const verifyMock = vi.fn();
const rateLimitedMock = vi.fn();
// Stub only the verifier; keep the real AppleTokenError class so the route's
// `err instanceof AppleTokenError` branch resolves against the same constructor a
// real verification failure would throw.
vi.mock('~/lib/auth/apple-id-token', async (importActual) => {
  const actual = await importActual<typeof import('~/lib/auth/apple-id-token')>();
  return {
    ...actual,
    verifyAppleIdToken: (...args: unknown[]) => verifyMock(...args),
  };
});
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
      throw new Error('mobile apple route must NOT touch the database (rule #1)');
    },
  };
});

const TEST_SECRET = 'test-auth-secret-mobile-apple-route-0123456789abc';

// The minted token's subject is the Apple account id (the identity token's `sub`),
// mirroring the Google route where token.sub is the provider account id. That id is
// users.external_auth_id, so a mobile Apple login resolves to a stable identity.
const APPLE_SUB = 'apple-account-sub-000123.abcdef.4242';
const APPLE_EMAIL = 'parent@icloud.com';

async function callPost(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/auth/apple/route');
  return POST(
    new Request('http://localhost/api/mobile/auth/apple', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/mobile/auth/apple', () => {
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

  it('returns 400 when identityToken is missing', async () => {
    const res = await callPost({ rawNonce: 'client-random-nonce' });

    expect(res.status).toBe(400);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('returns 400 when rawNonce is missing (every legit exchange is nonce-bound)', async () => {
    const res = await callPost({ identityToken: 'a.b.c' });

    expect(res.status).toBe(400);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-IP rate limit is tripped, without verifying the token', async () => {
    rateLimitedMock.mockResolvedValue(true);

    const res = await callPost({ identityToken: 'a.b.c', rawNonce: 'client-random-nonce' });

    expect(res.status).toBe(429);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('returns 200 with a token that round-trips to the Apple sub', async () => {
    verifyMock.mockResolvedValue({ sub: APPLE_SUB, email: APPLE_EMAIL });

    const res = await callPost(
      { identityToken: 'a.b.c', rawNonce: 'client-random-nonce' },
      { 'x-forwarded-proto': 'https' },
    );

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };

    const decoded = await getToken({
      req: new Request('https://x/api/anything', {
        headers: { authorization: `Bearer ${token}` },
      }),
      secret: TEST_SECRET,
      secureCookie: true,
    });

    expect(decoded?.sub).toBe(APPLE_SUB);
    expect(decoded?.email).toBe(APPLE_EMAIL);
  });

  it('forwards the raw nonce to the verifier so replay defense is enforced', async () => {
    verifyMock.mockResolvedValue({ sub: APPLE_SUB, email: APPLE_EMAIL });

    await callPost(
      { identityToken: 'a.b.c', rawNonce: 'client-random-nonce' },
      { 'x-forwarded-proto': 'https' },
    );

    expect(verifyMock).toHaveBeenCalledWith('a.b.c', { rawNonce: 'client-random-nonce' });
  });

  it('omits the email claim when the Apple identity has no email', async () => {
    verifyMock.mockResolvedValue({ sub: APPLE_SUB, email: undefined });

    const res = await callPost(
      { identityToken: 'a.b.c', rawNonce: 'client-random-nonce' },
      { 'x-forwarded-proto': 'https' },
    );

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };

    const decoded = await getToken({
      req: new Request('https://x/api/anything', {
        headers: { authorization: `Bearer ${token}` },
      }),
      secret: TEST_SECRET,
      secureCookie: true,
    });

    expect(decoded?.sub).toBe(APPLE_SUB);
    expect(decoded).not.toHaveProperty('email');
  });

  it('returns 401 with a generic body when verification throws a jose error', async () => {
    verifyMock.mockRejectedValue(new errors.JWTExpired('token expired', {}));

    const res = await callPost({ identityToken: 'a.b.c', rawNonce: 'client-random-nonce' });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  it('returns 401 when the nonce check fails (an AppleTokenError from the verifier)', async () => {
    const { AppleTokenError } = await import('~/lib/auth/apple-id-token');
    verifyMock.mockRejectedValue(new AppleTokenError('Apple identity token nonce mismatch'));

    const res = await callPost({ identityToken: 'a.b.c', rawNonce: 'x' });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  it('does not swallow a programming error (non-jose, non-AppleTokenError) as a 401', async () => {
    verifyMock.mockRejectedValue(new TypeError('bug: undefined is not a function'));

    await expect(
      callPost({ identityToken: 'a.b.c', rawNonce: 'client-random-nonce' }),
    ).rejects.toThrow('bug:');
  });
});
