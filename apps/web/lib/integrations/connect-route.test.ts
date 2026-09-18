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

async function callConnect(provider: string, query = '', origin = 'https://app.example.com') {
  const { GET } = await import('~/app/api/integrations/[provider]/connect/route');
  return GET(new Request(`${origin}/api/integrations/${provider}/connect${query}`) as never, {
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
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

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

/**
 * ONE HOST, and the test that says which one.
 *
 * The redirect_uri is registered with Google exactly once. Before VIL-350 this route
 * and the callback each computed `process.env.APP_URL ?? <request origin>`, so a
 * preview deploy sent Google a string Google had never been told about and the parent
 * met a Google error page. Both now read appBaseUrl(), and this suite is what stops
 * the `?? origin` growing back: the assertions are written so that reverting to the
 * request's own origin makes them fail.
 */
describe('GET /api/integrations/[provider]/connect - one host, never the request origin', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const m of [authMock, resolveFamilyMock, resolveUserIdMock]) m.mockReset();
    vi.stubEnv('AUTH_SECRET', 'test-signing-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'client-id.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'signin-secret');
    authMock.mockResolvedValue({ user: { id: 'ext-parent' } });
    resolveFamilyMock.mockResolvedValue(FAMILY);
    resolveUserIdMock.mockResolvedValue(USER);
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Half of the "identical by construction" pin: the consent carries exactly
   * connectorRedirectUri(). The other half is in callback-route.test.ts, where the
   * token exchange is asserted to send the same string — the two legs cannot drift
   * without one of the two failing. */
  it('sends Google exactly connectorRedirectUri()', async () => {
    const { connectorRedirectUri } = await import('./google-oauth');

    const res = await callConnect('gcal');

    const consent = new URL(res.headers.get('location') ?? '');
    expect(consent.searchParams.get('redirect_uri')).toBe(connectorRedirectUri());
    expect(consent.searchParams.get('redirect_uri')).toBe(
      'https://app.example.com/api/integrations/callback',
    );
  });

  /** The marketing host is a different site with a different door. If it ever became
   * the base for an app URL the consent would be registered nowhere. */
  it('never reaches for the marketing host', async () => {
    vi.stubEnv('NEXT_PUBLIC_MARKETING_URL', 'https://villagehale.com');

    const res = await callConnect('gcal');

    const redirectUri = new URL(res.headers.get('location') ?? '').searchParams.get('redirect_uri');
    expect(redirectUri).toBe('https://app.example.com/api/integrations/callback');
    expect(redirectUri).not.toContain('villagehale.com/');
  });

  it('refuses a host that is not the one Google has registered, and names it', async () => {
    const res = await callConnect('gcal', '', 'https://hale-web-git-branch.vercel.app');

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'wrong_host' });
    // And nothing was minted: a refused connect leaves no state for anyone to replay.
    expect(res.headers.get('location')).toBeNull();
  });

  it('refuses the off-host connect BEFORE it costs a session or a family read', async () => {
    await callConnect('gcal', '', 'https://hale-web-git-branch.vercel.app');

    expect(authMock).not.toHaveBeenCalled();
    expect(resolveFamilyMock).not.toHaveBeenCalled();
  });
});

/**
 * WHICH Google project granted the token, as the connect route reports it. The absence
 * of the connector pair is the fallback running, and it is named rather than silent
 * (rule #11) - connect must never fail because the new vars are missing.
 */
describe('GET /api/integrations/[provider]/connect - the project is named at connect time', () => {
  const infoLines: unknown[][] = [];
  beforeEach(() => {
    vi.resetModules();
    infoLines.length = 0;
    for (const m of [authMock, resolveFamilyMock, resolveUserIdMock]) m.mockReset();
    vi.stubEnv('AUTH_SECRET', 'test-signing-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'signin-id.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'signin-secret');
    authMock.mockResolvedValue({ user: { id: 'ext-parent' } });
    resolveFamilyMock.mockResolvedValue(FAMILY);
    resolveUserIdMock.mockResolvedValue(USER);
    vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
      infoLines.push(args);
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('starts consent on the sign-in project, and SAYS so, when the connector pair is unset', async () => {
    const res = await callConnect('gcal');

    expect(new URL(res.headers.get('location') ?? '').searchParams.get('client_id')).toBe(
      'signin-id.apps.googleusercontent.com',
    );
    expect(infoLines[0]?.[0]).toMatchObject({ oauthClient: 'signin_project', provider: 'gcal' });
  });

  it('prefers the connector project when both of its vars are set', async () => {
    vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_ID', 'connector-id.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_SECRET', 'connector-secret');

    const res = await callConnect('gcal');

    expect(new URL(res.headers.get('location') ?? '').searchParams.get('client_id')).toBe(
      'connector-id.apps.googleusercontent.com',
    );
    expect(infoLines[0]?.[0]).toMatchObject({ oauthClient: 'connector_project' });
  });

  /** Never a client id, never a secret, in the line or in the row it mirrors (rule #1). */
  it('names the project without printing the client it named', async () => {
    vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_ID', 'connector-id.apps.googleusercontent.com');
    vi.stubEnv('GOOGLE_CONNECTOR_CLIENT_SECRET', 'connector-secret');

    await callConnect('gcal');

    const line = JSON.stringify(infoLines[0]);
    expect(line).not.toContain('connector-id');
    expect(line).not.toContain('connector-secret');
  });
});
