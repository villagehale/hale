import { getToken } from 'next-auth/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reuses the SAME credential chokepoint as web (authenticateCredential
// + authRateLimited), then mints a mobile session JWT. We stub those edges so the
// test exercises the route's request-handling + minting, not the real argon2/DB.
// db() is never dereferenced (authenticateCredential is stubbed), so the no-real-
// handle mock convention applies.
const authenticateMock = vi.fn();
const rateLimitedMock = vi.fn();
vi.mock('~/lib/auth/credentials', () => ({
  authenticateCredential: (...args: unknown[]) => authenticateMock(...args),
}));
vi.mock('~/lib/auth/rate-limit', () => ({
  authRateLimited: () => rateLimitedMock(),
}));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

const TEST_SECRET = 'test-auth-secret-mobile-password-route-0123456789';

// Derived from the credentials contract (lib/auth/credentials.ts:
// credentialExternalAuthId = `credentials:${id}`), NOT copied from route output.
const CREDENTIAL_ID = 'cred-uuid-1';
const EXPECTED_SUB = `credentials:${CREDENTIAL_ID}`;
const EXPECTED_EMAIL = 'parent@hale.test';

async function callPost(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/auth/password/route');
  return POST(
    new Request('http://localhost/api/mobile/auth/password', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/mobile/auth/password', () => {
  beforeEach(() => {
    vi.resetModules();
    authenticateMock.mockReset();
    rateLimitedMock.mockReset();
    rateLimitedMock.mockResolvedValue(false);
    vi.stubEnv('AUTH_SECRET', TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 400 when email is missing', async () => {
    const res = await callPost({ password: 'hunter2hunter2' });

    expect(res.status).toBe(400);
    expect(authenticateMock).not.toHaveBeenCalled();
    expect(rateLimitedMock).not.toHaveBeenCalled();
  });

  it('returns 400 when password is missing', async () => {
    const res = await callPost({ email: EXPECTED_EMAIL });

    expect(res.status).toBe(400);
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty-string field', async () => {
    const res = await callPost({ email: '', password: 'hunter2hunter2' });

    expect(res.status).toBe(400);
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-IP rate limit is tripped, without checking the password', async () => {
    rateLimitedMock.mockResolvedValue(true);

    const res = await callPost({ email: EXPECTED_EMAIL, password: 'hunter2hunter2' });

    expect(res.status).toBe(429);
    expect(authenticateMock).not.toHaveBeenCalled();
  });

  it('returns 401 with a single generic body on bad credentials', async () => {
    authenticateMock.mockResolvedValue(null);

    const res = await callPost({ email: EXPECTED_EMAIL, password: 'wrong-password' });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('returns 200 with a token that round-trips through getToken with the credential sub', async () => {
    authenticateMock.mockResolvedValue({ id: EXPECTED_SUB, email: EXPECTED_EMAIL });

    const res = await callPost(
      { email: EXPECTED_EMAIL, password: 'correct-horse-battery' },
      { 'x-forwarded-proto': 'https' },
    );

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(typeof token).toBe('string');

    const decoded = await getToken({
      req: new Request('https://x/api/anything', {
        headers: { authorization: `Bearer ${token}` },
      }),
      secret: TEST_SECRET,
      secureCookie: true,
    });

    expect(decoded?.sub).toBe(EXPECTED_SUB);
    expect(decoded?.email).toBe(EXPECTED_EMAIL);
  });

  it('mints under the insecure salt for a plain-HTTP request', async () => {
    authenticateMock.mockResolvedValue({ id: EXPECTED_SUB, email: EXPECTED_EMAIL });

    const res = await callPost({ email: EXPECTED_EMAIL, password: 'correct-horse-battery' });

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const decoded = await getToken({
      req: new Request('http://x/api/anything', {
        headers: { authorization: `Bearer ${token}` },
      }),
      secret: TEST_SECRET,
      secureCookie: false,
    });

    expect(decoded?.sub).toBe(EXPECTED_SUB);
  });
});
