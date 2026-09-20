import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The callback stores tokens under the state's bound user. We stub every edge (auth,
// db, family resolver, token exchange, store) so the test exercises the
// consent-fixation binding (rule #1) — NOT the real infra. The token exchange +
// saveConnection are spies: the security assertion is that a MISMATCHED completer
// never reaches them.
const authMock = vi.fn();
const resolveUserIdMock = vi.fn();
const exchangeMock = vi.fn();
const saveConnectionMock = vi.fn();
const noticeMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({ resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a) }));
vi.mock('~/lib/channel/connect/connected-notice', async () => {
  const actual =
    await vi.importActual<typeof import('~/lib/channel/connect/connected-notice')>(
      '~/lib/channel/connect/connected-notice',
    );
  return {
    ...actual,
    defaultConnectedNoticePorts: () => ({ transport: { send: vi.fn() }, threadMessage: vi.fn() }),
    sendConnectorConnectedText: (...a: unknown[]) => noticeMock(...a),
  };
});
vi.mock('~/lib/integrations/google-oauth', async () => {
  const actual = await vi.importActual<typeof import('./google-oauth')>('./google-oauth');
  return { ...actual, exchangeCodeForTokens: (...a: unknown[]) => exchangeMock(...a) };
});
vi.mock('~/lib/integrations/store', () => ({
  saveConnection: (...a: unknown[]) => saveConnectionMock(...a),
}));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MINTER = '22222222-2222-4222-8222-222222222222';
const ATTACKER = '99999999-9999-4999-8999-999999999999';
const CONNECT_ID = '44444444-4444-4444-8444-444444444444';

async function callCallback(state: string, code = 'auth-code') {
  const { GET } = await import('~/app/api/integrations/callback/route');
  const qs = new URLSearchParams({ code, state }).toString();
  return GET(new Request(`http://localhost/api/integrations/callback?${qs}`) as never);
}

async function callCallbackDenied(state: string) {
  const { GET } = await import('~/app/api/integrations/callback/route');
  const qs = new URLSearchParams({ error: 'access_denied', state }).toString();
  return GET(new Request(`http://localhost/api/integrations/callback?${qs}`) as never);
}

function location(res: Response): string {
  return res.headers.get('location') ?? '';
}

describe('GET /api/integrations/callback — consent-fixation binding (rule #1)', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const m of [authMock, resolveUserIdMock, exchangeMock, saveConnectionMock]) {
      m.mockReset();
    }
    vi.stubEnv('AUTH_SECRET', 'test-signing-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    exchangeMock.mockResolvedValue({ accessToken: 'ya29.x', scope: 'https://www.googleapis.com/auth/calendar.readonly' });
    saveConnectionMock.mockResolvedValue({ connectId: CONNECT_ID });
  });
  afterEach(() => vi.unstubAllEnvs());

  async function webState(userId: string) {
    const { signConnectState } = await import('./connect-state');
    return signConnectState({ familyId: FAMILY, userId, provider: 'gcal' });
  }
  async function mobileState() {
    const { signConnectState } = await import('./connect-state');
    return signConnectState({ familyId: FAMILY, userId: MINTER, provider: 'gcal', surface: 'mobile' });
  }

  it('WEB: rejects when the completing session is a DIFFERENT user than the minter — no token exchange, no store', async () => {
    // The attacker minted a state bound to MINTER, then a victim (ATTACKER session
    // here stands in for "not the minter") completes consent. The tokens must NOT
    // be saved under the bound user.
    authMock.mockResolvedValue({ user: { id: 'ext-attacker' } });
    resolveUserIdMock.mockResolvedValue(ATTACKER);

    const res = await callCallback(await webState(MINTER));

    expect(location(res)).toContain('/settings?connect=invalid');
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(saveConnectionMock).not.toHaveBeenCalled();
  });

  it('WEB: rejects when the completer is signed OUT (no session binds the consent)', async () => {
    authMock.mockResolvedValue(null);
    resolveUserIdMock.mockResolvedValue(null);

    const res = await callCallback(await webState(MINTER));

    expect(location(res)).toContain('connect=invalid');
    expect(saveConnectionMock).not.toHaveBeenCalled();
  });

  it('WEB: stores the connection when the completing session IS the minter', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-minter' } });
    resolveUserIdMock.mockResolvedValue(MINTER);

    const res = await callCallback(await webState(MINTER));

    expect(saveConnectionMock).toHaveBeenCalledTimes(1);
    expect(saveConnectionMock.mock.calls[0]?.[1]).toMatchObject({ familyId: FAMILY, userId: MINTER, provider: 'gcal' });
    expect(location(res)).toContain('connect=gcal');
  });

  /** An unreadable state cannot name a surface, so it keeps the answer the web dead end
   * has always given: Google's own denial flag still says what happened. */
  it('WEB: a denial carrying an unreadable state is still a denial', async () => {
    const { GET } = await import('~/app/api/integrations/callback/route');
    const res = (await GET(
      new Request(
        'http://localhost/api/integrations/callback?error=access_denied&state=not-a-signed-state',
      ) as never,
    )) as Response;

    expect(location(res)).toBe('https://app.example.com/settings?connect=denied');
    // The positive control: the same unreadable state WITHOUT a denial is invalid.
    const forged = (await GET(
      new Request(
        'http://localhost/api/integrations/callback?code=auth-code&state=not-a-signed-state',
      ) as never,
    )) as Response;
    expect(location(forged)).toBe('https://app.example.com/settings?connect=invalid');
    expect(saveConnectionMock).not.toHaveBeenCalled();
  });

  it('MOBILE: rejects any mobile-surface state — the native mint was retired (VIL-318), so none is bindable', async () => {
    const res = await callCallback(await mobileState());

    expect(location(res)).toContain('/connected?status=invalid');
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(saveConnectionMock).not.toHaveBeenCalled();
    // No session check on the mobile leg — it is rejected before any binding.
    expect(authMock).not.toHaveBeenCalled();
  });
});

/**
 * The return leg of the texted connect: the parent tapped a link in a thread, so the
 * portal must not be in the path either way it ends — a done page they can close, and
 * one text back saying so. The receipt itself is the pglite suite's subject
 * (connected-notice.pglite.test.ts); here it is a port, and what is under test is that
 * the route calls it for the right connect and never lets its outcome reach the parent.
 */
describe('GET /api/integrations/callback — the text surface', () => {
  const CONNECT = '33333333-3333-4333-8333-333333333333';

  beforeEach(() => {
    vi.resetModules();
    for (const m of [authMock, resolveUserIdMock, exchangeMock, saveConnectionMock, noticeMock]) {
      m.mockReset();
    }
    vi.stubEnv('AUTH_SECRET', 'test-signing-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    exchangeMock.mockResolvedValue({
      accessToken: 'ya29.x',
      scope: 'https://www.googleapis.com/auth/calendar.readonly',
    });
    saveConnectionMock.mockResolvedValue({ connectId: CONNECT });
    noticeMock.mockResolvedValue({ status: 'sent', channelMessageId: 'cm-1' });
    authMock.mockResolvedValue({ user: { id: 'ext-minter' } });
    resolveUserIdMock.mockResolvedValue(MINTER);
  });
  afterEach(() => vi.unstubAllEnvs());

  async function textState(provider: 'gcal' | 'gmail' = 'gcal') {
    const { signConnectState } = await import('./connect-state');
    return signConnectState({ familyId: FAMILY, userId: MINTER, provider, surface: 'text' });
  }

  it('lands the parent on the done page and texts the receipt for the connect they made', async () => {
    const res = await callCallback(await textState('gcal'));

    expect(location(res)).toBe('https://app.example.com/connected?provider=gcal&status=ok');
    expect(noticeMock).toHaveBeenCalledTimes(1);
    expect(noticeMock.mock.calls[0]?.[1]).toMatchObject({
      familyId: FAMILY,
      parentUserId: MINTER,
      provider: 'gcal',
      connectId: CONNECT,
    });
  });

  it('still says connected when there is no number to text — the outcome is named, not shown', async () => {
    exchangeMock.mockResolvedValue({
      accessToken: 'ya29.x',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
    });
    noticeMock.mockResolvedValue({ status: 'not_sent', reason: 'no_send_target' });

    const res = await callCallback(await textState('gmail'));

    expect(location(res)).toBe('https://app.example.com/connected?provider=gmail&status=ok');
  });

  it('says nothing at all when the parent declined at Google', async () => {
    const res = await callCallbackDenied(await textState('gcal'));

    expect(location(res)).toBe('https://app.example.com/connected?provider=gcal&status=denied');
    expect(noticeMock).not.toHaveBeenCalled();
    expect(saveConnectionMock).not.toHaveBeenCalled();
  });

  it('sends the parent to the done page, never Settings, when the grant is too narrow', async () => {
    exchangeMock.mockResolvedValue({ accessToken: 'ya29.x', scope: '' });

    const res = await callCallback(await textState('gcal'));

    expect(location(res)).toBe('https://app.example.com/connected?provider=gcal&status=denied');
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it('binds the completer to the minter exactly as the web leg does', async () => {
    resolveUserIdMock.mockResolvedValue(ATTACKER);

    const res = await callCallback(await textState('gcal'));

    expect(location(res)).toBe('https://app.example.com/connected?provider=gcal&status=invalid');
    expect(saveConnectionMock).not.toHaveBeenCalled();
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it('leaves the Settings leg alone: no text, no done page', async () => {
    const { signConnectState } = await import('./connect-state');
    const state = signConnectState({ familyId: FAMILY, userId: MINTER, provider: 'gcal' });

    const res = await callCallback(state);

    expect(location(res)).toBe('https://app.example.com/settings?connect=gcal');
    expect(noticeMock).not.toHaveBeenCalled();
  });

  /** The other half of the redirect_uri pin (connect-route.test.ts holds the first):
   * the exchange sends the SAME string the consent was minted with. Google matches
   * the two, so a leg that read the request's own origin would fail here the moment
   * a preview host, an alias or a proxy header differed from the registered one. */
  it('exchanges the code against exactly connectorRedirectUri()', async () => {
    const { connectorRedirectUri } = await import('./google-oauth');

    await callCallback(await textState('gcal'));

    expect(exchangeMock.mock.calls[0]?.[0]).toMatchObject({
      redirectUri: connectorRedirectUri(),
    });
    expect(exchangeMock.mock.calls[0]?.[0]).toMatchObject({
      redirectUri: 'https://app.example.com/api/integrations/callback',
    });
  });
});

describe('GET /api/integrations/callback — granted-scope validation', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const m of [authMock, resolveUserIdMock, exchangeMock, saveConnectionMock]) {
      m.mockReset();
    }
    vi.stubEnv('AUTH_SECRET', 'test-signing-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    saveConnectionMock.mockResolvedValue({ connectId: CONNECT_ID });
    authMock.mockResolvedValue({ user: { id: 'ext-minter' } });
    resolveUserIdMock.mockResolvedValue(MINTER);
  });
  afterEach(() => vi.unstubAllEnvs());

  async function minterState() {
    const { signConnectState } = await import('./connect-state');
    return signConnectState({ familyId: FAMILY, userId: MINTER, provider: 'gcal' });
  }

  it('rejects a grant MISSING the connector scope (granular-consent deselect) — denied, nothing stored', async () => {
    exchangeMock.mockResolvedValue({ accessToken: 'ya29.x', scope: '' });
    const res = await callCallback(await minterState());
    expect(location(res)).toContain('connect=denied');
    expect(saveConnectionMock).not.toHaveBeenCalled();
  });

  it('rejects a grant BROADER than the readonly universe — denied, nothing stored', async () => {
    exchangeMock.mockResolvedValue({
      accessToken: 'ya29.x',
      scope:
        'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/gmail.send',
    });
    const res = await callCallback(await minterState());
    expect(location(res)).toContain('connect=denied');
    expect(saveConnectionMock).not.toHaveBeenCalled();
  });
});
