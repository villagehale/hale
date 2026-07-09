import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads the Auth.js session + db + family resolvers at request time. We
// stub those edges so the test exercises the route's Bearer gating + state binding
// (rule #1), not the real infra. Family/user resolution is stubbed to a fixed pair.
const authMock = vi.fn();
const NONCE_ID = '33333333-3333-4333-8333-333333333333';
vi.mock('~/auth', () => ({ auth: () => authMock() }));
// The route mints a single-use nonce row (mobile consent-fixation binding, rule #1)
// before signing the state — stub the insert to hand back a fixed nonce id.
vi.mock('~/lib/db', () => ({
  db: () => ({
    insert: () => ({ values: () => ({ returning: async () => [{ id: NONCE_ID }] }) }),
  }),
}));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: async () => '11111111-1111-4111-8111-111111111111',
  resolveUserIdForUser: async () => '22222222-2222-4222-8222-222222222222',
}));

async function callGet(provider?: string) {
  const { GET } = await import('~/app/api/mobile/integrations/connect-url/route');
  const qs = provider === undefined ? '' : `?provider=${encodeURIComponent(provider)}`;
  return GET(new Request(`http://localhost/api/mobile/integrations/connect-url${qs}`));
}

describe('GET /api/mobile/integrations/connect-url', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    vi.stubEnv('AUTH_SECRET', 'test-signing-secret');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'gid_test');
    vi.stubEnv('APP_URL', 'https://app.example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 when the caller is not signed in — never mints a consent url', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet('gcal');

    expect(res.status).toBe(401);
  });

  it('returns 400 for an unsupported provider (rejects non-connector values)', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet('slack');

    expect(res.status).toBe(400);
  });

  it('returns 400 when no provider is given', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet();

    expect(res.status).toBe(400);
  });

  it('returns a consent url requesting OFFLINE access + forced CONSENT for the signed-in family', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet('gcal');
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const params = new URL(url).searchParams;

    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth')).toBe(true);
    expect(params.get('access_type')).toBe('offline'); // refresh token for background sync
    expect(params.get('prompt')).toBe('consent');
    expect(params.get('redirect_uri')).toBe('https://app.example.com/api/integrations/callback');
    expect(params.get('state')).toBeTruthy();
  });

  it.each([
    ['gcal', 'https://www.googleapis.com/auth/calendar.readonly'],
    ['gmail', 'https://www.googleapis.com/auth/gmail.readonly'],
    ['gdrive', 'https://www.googleapis.com/auth/drive.readonly'],
  ])('requests ONLY the read-only %s scope (rule #1)', async (provider, scope) => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet(provider);
    const { url } = (await res.json()) as { url: string };
    const requested = new URL(url).searchParams.get('scope');

    expect(requested).toBe(scope);
    expect(requested).toContain('readonly'); // never a write/full scope
  });

  it('binds the consent to a mobile surface in the signed state (callback redirects to /connected)', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet('gmail');
    const { url } = (await res.json()) as { url: string };
    const state = new URL(url).searchParams.get('state') ?? '';

    const { verifyConnectState } = await import('~/lib/integrations/connect-state');
    const bound = verifyConnectState(state);
    expect(bound.surface).toBe('mobile');
    expect(bound.provider).toBe('gmail');
    expect(bound.familyId).toBe('11111111-1111-4111-8111-111111111111');
    // The mobile state carries the single-use nonce the callback consumes (rule #1).
    expect(bound.nonce).toBe(NONCE_ID);
  });

  it('returns 503 when the DB is not configured (dev preview)', async () => {
    vi.stubEnv('DATABASE_URL', '');
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet('gcal');

    expect(res.status).toBe(503);
    expect(authMock).not.toHaveBeenCalled();
  });
});
