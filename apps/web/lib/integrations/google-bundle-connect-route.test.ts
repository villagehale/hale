import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VIL-721 · the start of the ONE Google link: `api/integrations/google/connect`. It
 * exists only while THREAD_ONBOARDING_V2_ENABLED is exactly `true`, only for a texted
 * link (`from=text`), and it signs a state naming the bundle, which the callback reads
 * back instead of trusting anything a browser wrote.
 *
 * Every edge is stubbed (auth, db, the family resolvers, the token owner check); what
 * is under test is the gate and the state this route signs, read with the real verifier.
 */

const authMock = vi.fn();
const resolveFamilyMock = vi.fn();
const resolveUserIdMock = vi.fn();
const tokenOwnedMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));
vi.mock('~/lib/auth/channel-signin', async () => {
  const actual = await vi.importActual<typeof import('~/lib/auth/channel-signin')>(
    '~/lib/auth/channel-signin',
  );
  return {
    ...actual,
    channelSigninTokenBelongsToUser: (...a: unknown[]) => tokenOwnedMock(...a),
  };
});

const FAMILY = '11111111-1111-4111-8111-111111111111';
const USER = '22222222-2222-4222-8222-222222222222';
const LINK = '33333333-3333-4333-8333-333333333333';
const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
const GCAL = 'https://www.googleapis.com/auth/calendar.events.owned.readonly';
const PROFILE = 'https://www.googleapis.com/auth/userinfo.profile';

async function callBundle(query = '?from=text', origin = 'https://app.example.com') {
  const { GET } = await import('~/app/api/integrations/google/connect/route');
  return GET(new Request(`${origin}/api/integrations/google/connect${query}`) as never);
}

async function boundState(res: Response) {
  const { verifyConnectState } = await import('./connect-state');
  const consent = new URL(res.headers.get('location') ?? '');
  return verifyConnectState(consent.searchParams.get('state') ?? '');
}

beforeEach(() => {
  vi.resetModules();
  for (const m of [authMock, resolveFamilyMock, resolveUserIdMock, tokenOwnedMock]) {
    m.mockReset();
  }
  vi.stubEnv('AUTH_SECRET', 'test-signing-secret');
  vi.stubEnv('APP_URL', 'https://app.example.com');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'client-id.apps.googleusercontent.com');
  vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_ID', '');
  vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_SECRET', '');
  vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'true');
  vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
  // Read scopes only, pinned: the flags-on CI job also arms the write scopes.
  vi.stubEnv('GOOGLE_WRITE_SCOPES_ENABLED', 'false');
  authMock.mockResolvedValue({ user: { id: 'ext-parent' } });
  resolveFamilyMock.mockResolvedValue(FAMILY);
  resolveUserIdMock.mockResolvedValue(USER);
  tokenOwnedMock.mockResolvedValue(true);
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('GET /api/integrations/google/connect (VIL-721)', () => {
  it.each([undefined, 'false', 'TRUE', 'true\n'])(
    'starts nothing while the flag is not exactly true (%j)',
    async (value) => {
      vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', value);
      const res = await callBundle();
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_offered' });
      expect(authMock).not.toHaveBeenCalled();
    },
  );

  it('starts nothing while the friend walk it rides is off', async () => {
    vi.stubEnv('COLD_START_LADDER_ENABLED', undefined);
    const res = await callBundle();
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_offered' });
  });

  it('is a texted link only: without from=text nothing starts', async () => {
    const res = await callBundle('');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'text_only' });
  });

  it('names the wrong host instead of minting a redirect Google would refuse', async () => {
    const res = await callBundle('?from=text', 'https://preview-branch.vercel.app');
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'wrong_host' });
  });

  it('refuses a signed-out request', async () => {
    authMock.mockResolvedValue(null);
    const res = await callBundle();
    expect(res.status).toBe(401);
  });

  it('refuses a session with no family', async () => {
    resolveFamilyMock.mockResolvedValue(null);
    const res = await callBundle();
    expect(res.status).toBe(403);
  });

  it('opens one Google consent for both read scopes and signs the bundle into the state', async () => {
    const res = await callBundle();
    const consent = new URL(res.headers.get('location') ?? '');
    expect(consent.origin).toBe('https://accounts.google.com');
    expect(consent.searchParams.get('scope')?.split(' ')).toEqual([GMAIL, GCAL, PROFILE]);
    expect(consent.searchParams.has('include_granted_scopes')).toBe(false);
    expect(await boundState(res)).toEqual({
      familyId: FAMILY,
      userId: USER,
      provider: 'google',
      surface: 'text',
    });
  });

  it('carries the texted link inside the state when it is this parent’s, so the callback burns that one', async () => {
    const res = await callBundle(`?from=text&link=${LINK}`);
    expect(await boundState(res)).toMatchObject({ provider: 'google', channelSigninTokenId: LINK });
  });

  it('leaves a link that is not this parent’s out of the state, and still starts the consent', async () => {
    tokenOwnedMock.mockResolvedValue(false);
    const res = await callBundle(`?from=text&link=${LINK}`);
    const state = await boundState(res);
    expect(state.provider).toBe('google');
    expect(state).not.toHaveProperty('channelSigninTokenId');
  });
});
