import { getToken } from 'next-auth/jwt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reuses the SAME token consume the web magic-link provider uses
// (consumeMagicLinkToken), then mints a mobile session JWT. We stub those edges so
// the test exercises the route's request-handling + minting, not the real DB. db()
// is never dereferenced (consume is stubbed), so the no-real-handle convention
// applies.
const consumeMock = vi.fn();
const rateLimitedMock = vi.fn();
vi.mock('~/lib/auth/magic-link', () => ({
  consumeMagicLinkToken: (...args: unknown[]) => consumeMock(...args),
}));
vi.mock('~/lib/auth/rate-limit', () => ({
  authRateLimited: () => rateLimitedMock(),
}));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));

// Poison the DB connection factory (repo convention, rule #1): this route must
// never construct a database handle regardless of env.
vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile magic-link verify route must NOT touch the database (rule #1)');
    },
  };
});

const TEST_SECRET = 'test-auth-secret-mobile-magic-verify-route-0123456789';

// Derived from the credentials contract (credentialExternalAuthId = `credentials:${id}`),
// NOT copied from route output.
const CREDENTIAL_ID = 'cred-uuid-1';
const EXPECTED_SUB = `credentials:${CREDENTIAL_ID}`;
const EXPECTED_EMAIL = 'parent@hale.test';

async function callPost(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/auth/magic-link/verify/route');
  return POST(
    new Request('http://localhost/api/mobile/auth/magic-link/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/mobile/auth/magic-link/verify', () => {
  beforeEach(() => {
    vi.resetModules();
    consumeMock.mockReset();
    rateLimitedMock.mockReset();
    rateLimitedMock.mockResolvedValue(false);
    vi.stubEnv('AUTH_SECRET', TEST_SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 400 when the token is missing', async () => {
    const res = await callPost({});

    expect(res.status).toBe(400);
    expect(consumeMock).not.toHaveBeenCalled();
    expect(rateLimitedMock).not.toHaveBeenCalled();
  });

  it('returns 429 when the per-IP rate limit is tripped, without consuming the token', async () => {
    rateLimitedMock.mockResolvedValue(true);

    const res = await callPost({ token: 'some-token' });

    expect(res.status).toBe(429);
    expect(consumeMock).not.toHaveBeenCalled();
  });

  it('returns 401 with a single generic body for an unusable token', async () => {
    consumeMock.mockResolvedValue({ ok: false });

    const res = await callPost({ token: 'expired-or-used' });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid_token' });
  });

  it('returns 200 with a bearer that round-trips through getToken with the credential sub', async () => {
    consumeMock.mockResolvedValue({ ok: true, identity: { id: EXPECTED_SUB, email: EXPECTED_EMAIL } });

    const res = await callPost({ token: 'good-token' }, { 'x-forwarded-proto': 'https' });

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
    consumeMock.mockResolvedValue({ ok: true, identity: { id: EXPECTED_SUB, email: EXPECTED_EMAIL } });

    const res = await callPost({ token: 'good-token' });

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
