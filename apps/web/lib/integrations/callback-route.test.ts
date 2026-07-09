import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The callback stores tokens under the state's bound user. We stub every edge (auth,
// db, family resolver, nonce, token exchange, store) so the test exercises the
// consent-fixation binding (rule #1) — NOT the real infra. The token exchange +
// saveConnection are spies: the security assertion is that a MISMATCHED completer
// never reaches them.
const authMock = vi.fn();
const resolveUserIdMock = vi.fn();
const consumeNonceMock = vi.fn();
const exchangeMock = vi.fn();
const saveConnectionMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({ resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a) }));
vi.mock('~/lib/integrations/connect-nonce', () => ({
  consumeConnectNonce: (...a: unknown[]) => consumeNonceMock(...a),
}));
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

async function callCallback(state: string, code = 'auth-code') {
  const { GET } = await import('~/app/api/integrations/callback/route');
  const qs = new URLSearchParams({ code, state }).toString();
  return GET(new Request(`http://localhost/api/integrations/callback?${qs}`) as never);
}

function location(res: Response): string {
  return res.headers.get('location') ?? '';
}

describe('GET /api/integrations/callback — consent-fixation binding (rule #1)', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const m of [authMock, resolveUserIdMock, consumeNonceMock, exchangeMock, saveConnectionMock]) {
      m.mockReset();
    }
    vi.stubEnv('AUTH_SECRET', 'test-signing-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    exchangeMock.mockResolvedValue({ accessToken: 'ya29.x', scope: 'https://www.googleapis.com/auth/calendar.readonly' });
    saveConnectionMock.mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllEnvs());

  async function webState(userId: string) {
    const { signConnectState } = await import('./connect-state');
    return signConnectState({ familyId: FAMILY, userId, provider: 'gcal' });
  }
  async function mobileState(nonce: string) {
    const { signConnectState } = await import('./connect-state');
    return signConnectState({ familyId: FAMILY, userId: MINTER, provider: 'gcal', surface: 'mobile', nonce });
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
    // The web leg NEVER consults the mobile nonce.
    expect(consumeNonceMock).not.toHaveBeenCalled();
  });

  it('MOBILE: rejects (and never stores) when the single-use nonce is already spent', async () => {
    consumeNonceMock.mockResolvedValue(false); // already used / expired / wrong family

    const res = await callCallback(await mobileState('33333333-3333-4333-8333-333333333333'));

    expect(location(res)).toContain('/connected?status=invalid');
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(saveConnectionMock).not.toHaveBeenCalled();
    // No session check on the mobile leg.
    expect(authMock).not.toHaveBeenCalled();
  });

  it('MOBILE: consumes the nonce and stores when it is fresh', async () => {
    consumeNonceMock.mockResolvedValue(true);

    const res = await callCallback(await mobileState('33333333-3333-4333-8333-333333333333'));

    expect(consumeNonceMock).toHaveBeenCalledWith(expect.anything(), '33333333-3333-4333-8333-333333333333', FAMILY);
    expect(saveConnectionMock).toHaveBeenCalledTimes(1);
    expect(location(res)).toContain('/connected?provider=gcal');
  });

  it('MOBILE: rejects a state with no nonce at all (never consumes / stores)', async () => {
    const { signConnectState } = await import('./connect-state');
    const state = signConnectState({ familyId: FAMILY, userId: MINTER, provider: 'gcal', surface: 'mobile' });

    const res = await callCallback(state);

    expect(location(res)).toContain('/connected?status=invalid');
    expect(consumeNonceMock).not.toHaveBeenCalled();
    expect(saveConnectionMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/integrations/callback — granted-scope validation', () => {
  beforeEach(() => {
    vi.resetModules();
    for (const m of [authMock, resolveUserIdMock, consumeNonceMock, exchangeMock, saveConnectionMock]) {
      m.mockReset();
    }
    vi.stubEnv('AUTH_SECRET', 'test-signing-secret');
    vi.stubEnv('APP_URL', 'https://app.example.com');
    saveConnectionMock.mockResolvedValue(undefined);
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
