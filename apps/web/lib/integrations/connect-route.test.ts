import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The mint side of the texted connect flow: `?from=text` is what tells the callback the
 * parent is standing in a text thread rather than in Settings, and it travels inside the
 * SIGNED state so nothing on the return leg has to trust a query string.
 *
 * Every edge is stubbed (auth, db, the family resolvers) — what is under test is the
 * state this route signs, read back with the real verifier.
 */

const authMock = vi.fn();
const resolveFamilyMock = vi.fn();
const resolveUserIdMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';

async function callConnect(provider: string, query = '') {
  const { GET } = await import('~/app/api/integrations/[provider]/connect/route');
  return GET(new Request(`http://localhost/api/integrations/${provider}/connect${query}`) as never, {
    params: Promise.resolve({ provider }),
  });
}

/** The signed state Google is told to echo back, read with the real verifier. */
async function boundState(res: Response) {
  const { verifyConnectState } = await import('./connect-state');
  const consent = new URL(res.headers.get('location') ?? '');
  return verifyConnectState(consent.searchParams.get('state') ?? '');
}

describe('GET /api/integrations/[provider]/connect — which surface the consent came from', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const m of [authMock, resolveFamilyMock, resolveUserIdMock]) m.mockReset();
    vi.stubEnv('AUTH_SECRET', 'test-signing-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'client-id.apps.googleusercontent.com');
    vi.stubEnv('NEXTAUTH_SECRET', 'test-signing-secret');
    authMock.mockResolvedValue({ user: { id: 'ext-parent' } });
    resolveFamilyMock.mockResolvedValue(FAMILY);
    resolveUserIdMock.mockResolvedValue(USER);
  });
  afterEach(() => vi.unstubAllEnvs());

  it('stamps surface "text" when the parent arrived from the texted link', async () => {
    const res = await callConnect('gcal', '?from=text');

    expect(await boundState(res)).toEqual({
      familyId: FAMILY,
      userId: USER,
      provider: 'gcal',
      surface: 'text',
    });
  });

  it('leaves the surface unset for the Settings button, so the web leg is untouched', async () => {
    const res = await callConnect('gcal');

    expect(await boundState(res)).toEqual({ familyId: FAMILY, userId: USER, provider: 'gcal' });
  });

  it('refuses the text surface for a provider Hale has no text-back path for', async () => {
    // Drive syncs but nothing texts about it, so a "text" receipt for it would be a
    // promise Hale cannot keep — the flow falls back to the web surface.
    const res = await callConnect('gdrive', '?from=text');

    expect(await boundState(res)).toEqual({ familyId: FAMILY, userId: USER, provider: 'gdrive' });
  });
});
