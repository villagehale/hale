import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// VIL-721 · the return leg of the ONE texted Google link (`provider: 'google'` in the
// signed state). Every edge the callback touches is a spy, as in callback-route.test.ts:
// what is under test is the route's own decisions (which grant is stored, under whom,
// how many rows, which link goes out after a failure, what the done page says), not the
// infra behind them.
const authMock = vi.fn();
const resolveUserIdMock = vi.fn();
const resolveFamilyMock = vi.fn();
const exchangeMock = vi.fn();
const saveConnectionMock = vi.fn();
const noticeMock = vi.fn();
const readProfileMock = vi.fn();
const readSubMock = vi.fn();
const accountHeldMock = vi.fn();
const holdNameMock = vi.fn();
const kickMock = vi.fn();
const freshMock = vi.fn();
const settleSupersededMock = vi.fn();
const burnMock = vi.fn();

vi.mock('~/lib/channel/connect/fresh-link', () => ({
  textFreshConnectorLink: (...a: unknown[]) => freshMock(...a),
}));
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/channel/household-timezone', () => ({
  householdTimezone: async () => 'America/Toronto',
}));
vi.mock('~/lib/family', () => ({
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
}));
vi.mock('~/lib/auth/channel-signin', async () => {
  // Spread: other modules read this one's constants at import time (said-line.ts).
  const actual = await vi.importActual<typeof import('~/lib/auth/channel-signin')>(
    '~/lib/auth/channel-signin',
  );
  return { ...actual, consumeChannelSigninTokenById: (...a: unknown[]) => burnMock(...a) };
});
vi.mock('~/lib/channel/connect/connected-notice', async () => {
  const actual = await vi.importActual<typeof import('~/lib/channel/connect/connected-notice')>(
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
  otherParentHoldsGoogleAccount: (...a: unknown[]) => accountHeldMock(...a),
}));
vi.mock('~/lib/integrations/google-disconnect', () => ({
  settleSupersededGoogleRevoke: (...a: unknown[]) => settleSupersededMock(...a),
}));
vi.mock('~/lib/integrations/google-profile', () => ({
  readGoogleGivenName: (...a: unknown[]) => readProfileMock(...a),
  readGoogleAccountSub: (...a: unknown[]) => readSubMock(...a),
}));
vi.mock('~/lib/channel/identity/parent-call-name', () => ({
  holdGoogleGivenName: (...a: unknown[]) => holdNameMock(...a),
}));
vi.mock('~/lib/integrations/booked-backfill-kick', () => ({
  kickGmailBookedBackfill: (...a: unknown[]) => kickMock(...a),
}));

const FAMILY = '11111111-1111-4111-8111-111111111111';
const MINTER = '22222222-2222-4222-8222-222222222222';
const OTHER = '99999999-9999-4999-8999-999999999999';
const GMAIL_ROW = '44444444-4444-4444-8444-444444444444';
const GCAL_ROW = '55555555-5555-4555-8555-555555555555';
const LINK = '66666666-6666-4666-8666-666666666666';

const GMAIL = 'https://www.googleapis.com/auth/gmail.readonly';
const GCAL = 'https://www.googleapis.com/auth/calendar.events.owned.readonly';
const PROFILE = 'https://www.googleapis.com/auth/userinfo.profile';
const DRIVE = 'https://www.googleapis.com/auth/drive.readonly';

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

async function bundleState(extra: { surface?: 'text'; channelSigninTokenId?: string } = {}) {
  const { signConnectState } = await import('./connect-state');
  return signConnectState({
    familyId: FAMILY,
    userId: MINTER,
    provider: 'google',
    surface: 'text',
    channelSigninTokenId: LINK,
    ...extra,
  });
}

function granted(...scopes: string[]) {
  exchangeMock.mockResolvedValue({ accessToken: 'ya29.bundle', scope: scopes.join(' ') });
}

beforeEach(() => {
  vi.resetModules();
  for (const m of [
    authMock,
    resolveUserIdMock,
    resolveFamilyMock,
    exchangeMock,
    saveConnectionMock,
    noticeMock,
    readProfileMock,
    readSubMock,
    accountHeldMock,
    holdNameMock,
    kickMock,
    freshMock,
    settleSupersededMock,
    burnMock,
  ]) {
    m.mockReset();
  }
  vi.stubEnv('AUTH_SECRET', 'test-signing-secret');
  vi.stubEnv('APP_URL', 'https://app.example.com');
  // The blind index of the Google account id needs the app key; a test-only constant.
  vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
  vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'true');
  vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
  freshMock.mockResolvedValue('not_enrolled');
  settleSupersededMock.mockResolvedValue('revoked');
  kickMock.mockResolvedValue({ outcome: 'completed' });
  readProfileMock.mockResolvedValue(null);
  readSubMock.mockResolvedValue('google-sub-1');
  accountHeldMock.mockResolvedValue(false);
  holdNameMock.mockResolvedValue('held');
  burnMock.mockResolvedValue({ ok: true });
  noticeMock.mockResolvedValue({ status: 'sent', channelMessageId: 'cm-1' });
  authMock.mockResolvedValue({ user: { id: 'ext-minter' } });
  resolveUserIdMock.mockResolvedValue(MINTER);
  resolveFamilyMock.mockResolvedValue(FAMILY);
  saveConnectionMock.mockImplementation(async (_db: unknown, input: { provider: string }) => ({
    connectId: input.provider === 'gmail' ? GMAIL_ROW : GCAL_ROW,
    superseded: null,
  }));
  // The aha reads go to Google through fetch: a refusal, so each read is a failed snapshot.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 503 })),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/integrations/callback — the one Google link (VIL-721)', () => {
  it('stores Gmail and the calendar as two rows holding the same token, and sends one receipt', async () => {
    granted(GMAIL, GCAL, PROFILE);
    const res = await callCallback(await bundleState({ channelSigninTokenId: LINK }));

    expect(location(res)).toBe('https://app.example.com/connected?provider=google&status=ok');
    expect(saveConnectionMock).toHaveBeenCalledTimes(2);
    const [gmail, gcal] = saveConnectionMock.mock.calls.map((call) => call[1]);
    expect(gmail).toMatchObject({ familyId: FAMILY, userId: MINTER, provider: 'gmail' });
    expect(gcal).toMatchObject({ familyId: FAMILY, userId: MINTER, provider: 'gcal' });
    expect(gmail.tokens).toEqual(gcal.tokens);
    // The row's scopes are the token's: no row claims less power than its token holds.
    expect(gmail.scopes).toEqual([GMAIL, GCAL, PROFILE]);
    expect(gcal.scopes).toEqual([GMAIL, GCAL, PROFILE]);

    expect(noticeMock).toHaveBeenCalledTimes(1);
    expect(noticeMock.mock.calls[0]?.[1]).toMatchObject({
      familyId: FAMILY,
      parentUserId: MINTER,
      provider: 'google',
      connectId: GMAIL_ROW,
      fromBundle: true,
    });
    expect(noticeMock.mock.calls[0]?.[1].aha).toMatchObject({ provider: 'google' });

    // The texted link is burned once, after the consent landed.
    expect(burnMock).toHaveBeenCalledTimes(1);
    expect(burnMock.mock.calls[0]?.[1]).toEqual({
      tokenId: LINK,
      userId: MINTER,
      ignoreExpiry: true,
    });
    // Gmail landed, so its backfill is kicked, on its own row.
    expect(kickMock).toHaveBeenCalledTimes(1);
    expect(kickMock.mock.calls[0]?.[1]).toMatchObject({ id: GMAIL_ROW, familyId: FAMILY });
    expect(freshMock).not.toHaveBeenCalled();
  });

  it('stores only Gmail when the calendar box was left unticked, and the receipt names Gmail', async () => {
    granted(GMAIL, PROFILE);
    const res = await callCallback(await bundleState());

    expect(location(res)).toBe('https://app.example.com/connected?provider=gmail&status=ok');
    expect(saveConnectionMock).toHaveBeenCalledTimes(1);
    expect(saveConnectionMock.mock.calls[0]?.[1]).toMatchObject({ provider: 'gmail' });
    expect(noticeMock).toHaveBeenCalledTimes(1);
    expect(noticeMock.mock.calls[0]?.[1]).toMatchObject({
      provider: 'gmail',
      connectId: GMAIL_ROW,
      fromBundle: true,
    });
    expect(burnMock).toHaveBeenCalledTimes(1);
  });

  it('stores only the calendar when the Gmail box was left unticked, and kicks no Gmail backfill', async () => {
    granted(GCAL, PROFILE);
    const res = await callCallback(await bundleState());

    expect(location(res)).toBe('https://app.example.com/connected?provider=gcal&status=ok');
    expect(saveConnectionMock).toHaveBeenCalledTimes(1);
    expect(saveConnectionMock.mock.calls[0]?.[1]).toMatchObject({ provider: 'gcal' });
    expect(noticeMock.mock.calls[0]?.[1]).toMatchObject({ provider: 'gcal', fromBundle: true });
    expect(kickMock).not.toHaveBeenCalled();
  });

  it('stores nothing from a grant broader than the consent asked, and texts a fresh ONE link', async () => {
    granted(GMAIL, GCAL, DRIVE);
    freshMock.mockResolvedValue('sent');
    const res = await callCallback(await bundleState());

    expect(location(res)).toBe(
      'https://app.example.com/connected?provider=google&status=denied&fresh=sent',
    );
    expect(saveConnectionMock).not.toHaveBeenCalled();
    expect(noticeMock).not.toHaveBeenCalled();
    expect(freshMock).toHaveBeenCalledTimes(1);
    expect(freshMock.mock.calls[0]?.[1]).toMatchObject({
      familyId: FAMILY,
      parentUserId: MINTER,
      provider: 'google',
    });
  });

  it('is partial when neither box was ticked: nothing stored, a fresh one link', async () => {
    granted(PROFILE);
    const res = await callCallback(await bundleState());

    expect(location(res)).toBe('https://app.example.com/connected?provider=google&status=partial');
    expect(saveConnectionMock).not.toHaveBeenCalled();
    expect(freshMock.mock.calls[0]?.[1]).toMatchObject({ provider: 'google' });
  });

  it('answers a denial on the text surface with a fresh one link, and exchanges nothing', async () => {
    const res = await callCallbackDenied(await bundleState());

    expect(location(res)).toBe('https://app.example.com/connected?provider=google&status=denied');
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(freshMock.mock.calls[0]?.[1]).toMatchObject({ provider: 'google' });
  });

  it('mints no fresh link when the flag went off while the consent was at Google', async () => {
    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'false');
    granted(PROFILE);
    const res = await callCallback(await bundleState());

    expect(location(res)).toBe('https://app.example.com/connected?provider=google&status=partial');
    expect(freshMock).not.toHaveBeenCalled();
    expect(saveConnectionMock).not.toHaveBeenCalled();
  });

  it('still completes a granted consent that was in flight when the flag went off', async () => {
    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'false');
    granted(GMAIL, GCAL, PROFILE);
    const res = await callCallback(await bundleState());

    expect(location(res)).toBe('https://app.example.com/connected?provider=google&status=ok');
    expect(saveConnectionMock).toHaveBeenCalledTimes(2);
  });

  it('refuses a completer who is not the minter: no exchange, no row (consent fixation)', async () => {
    resolveUserIdMock.mockResolvedValue(OTHER);
    const res = await callCallback(await bundleState());

    expect(location(res)).toBe('https://app.example.com/connected?provider=google&status=invalid');
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(saveConnectionMock).not.toHaveBeenCalled();
  });

  it('texts nobody for a completer who is not the minter: holding a state sends no text', async () => {
    resolveUserIdMock.mockResolvedValue(OTHER);
    await callCallback(await bundleState());
    await callCallbackDenied(await bundleState());

    expect(freshMock).not.toHaveBeenCalled();
    expect(burnMock).not.toHaveBeenCalled();
  });

  it('refuses a state whose parent is now in another family: no burn, no exchange, no row', async () => {
    resolveFamilyMock.mockResolvedValue(OTHER);
    granted(GMAIL, GCAL);
    const res = await callCallback(await bundleState());

    expect(location(res)).toBe('https://app.example.com/connected?provider=google&status=invalid');
    expect(burnMock).not.toHaveBeenCalled();
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(saveConnectionMock).not.toHaveBeenCalled();
    expect(freshMock).not.toHaveBeenCalled();
  });

  it('spends the texted link before the code is exchanged, so a state completes once', async () => {
    const order: string[] = [];
    burnMock.mockImplementation(async () => {
      order.push('burn');
      return { ok: true };
    });
    exchangeMock.mockImplementation(async () => {
      order.push('exchange');
      return { accessToken: 'ya29.bundle', scope: `${GMAIL} ${GCAL} ${PROFILE}` };
    });
    const res = await callCallback(await bundleState());

    expect(location(res)).toBe('https://app.example.com/connected?provider=google&status=ok');
    expect(order).toEqual(['burn', 'exchange']);
    expect(burnMock).toHaveBeenCalledTimes(1);
    expect(burnMock.mock.calls[0]?.[1]).toMatchObject({ tokenId: LINK, userId: MINTER });
  });

  it('refuses a replayed state: nothing exchanged, nothing stored, and no text sent', async () => {
    burnMock.mockResolvedValue({ ok: false, reason: 'spent' });
    granted(GMAIL, GCAL);
    const replayed = await callCallback(await bundleState());
    const replayedDenial = await callCallbackDenied(await bundleState());

    for (const res of [replayed, replayedDenial]) {
      expect(location(res)).toBe(
        'https://app.example.com/connected?provider=google&status=invalid',
      );
    }
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(saveConnectionMock).not.toHaveBeenCalled();
    expect(freshMock).not.toHaveBeenCalled();
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it('refuses a state carrying no texted link, since nothing could spend it', async () => {
    const { signConnectState } = await import('./connect-state');
    granted(GMAIL, GCAL);
    const unbound = signConnectState({
      familyId: FAMILY,
      userId: MINTER,
      provider: 'google',
      surface: 'text',
    });
    const res = await callCallback(unbound);

    expect(location(res)).toBe('https://app.example.com/connected?provider=google&status=invalid');
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(saveConnectionMock).not.toHaveBeenCalled();
  });

  it('refuses a bundle state that did not start from a text: nothing exchanged, nothing stored', async () => {
    const { signConnectState } = await import('./connect-state');
    const web = signConnectState({ familyId: FAMILY, userId: MINTER, provider: 'google' });
    const res = await callCallback(web);

    expect(location(res)).toBe('https://app.example.com/settings?connect=invalid');
    expect(exchangeMock).not.toHaveBeenCalled();
    expect(saveConnectionMock).not.toHaveBeenCalled();
    expect(freshMock).not.toHaveBeenCalled();
  });

  it('stores nothing when Google will not say whose account this is, and sends one fresh link', async () => {
    granted(GMAIL, GCAL, PROFILE);
    readSubMock.mockResolvedValue(null);
    const res = await callCallback(await bundleState());

    expect(location(res)).toBe('https://app.example.com/connected?provider=google&status=error');
    expect(saveConnectionMock).not.toHaveBeenCalled();
    expect(noticeMock).not.toHaveBeenCalled();
    expect(freshMock).toHaveBeenCalledTimes(1);
  });

  it('stores nothing when the profile box was left unticked: the account cannot be told apart', async () => {
    granted(GMAIL, GCAL);
    const res = await callCallback(await bundleState());

    expect(location(res)).toBe('https://app.example.com/connected?provider=google&status=partial');
    expect(saveConnectionMock).not.toHaveBeenCalled();
    expect(readSubMock).not.toHaveBeenCalled();
    expect(freshMock).toHaveBeenCalledTimes(1);
  });

  it("stores nothing when the Google account is the other parent's", async () => {
    granted(GMAIL, GCAL, PROFILE);
    // The blind index of the account id needs the app key; a test-only constant.
    vi.stubEnv('APP_ENCRYPTION_KEY', Buffer.alloc(32, 7).toString('base64'));
    readSubMock.mockResolvedValue('google-sub-1');
    accountHeldMock.mockResolvedValue(true);
    const res = await callCallback(await bundleState());

    expect(location(res)).toBe('https://app.example.com/connected?provider=google&status=own_link');
    expect(saveConnectionMock).not.toHaveBeenCalled();
    expect(noticeMock).not.toHaveBeenCalled();
  });

  it('keeps the single-connector path as it was: one row, its own receipt, no bundle', async () => {
    granted(GCAL);
    const { signConnectState } = await import('./connect-state');
    const single = signConnectState({
      familyId: FAMILY,
      userId: MINTER,
      provider: 'gcal',
      surface: 'text',
    });
    const res = await callCallback(single);

    expect(location(res)).toBe('https://app.example.com/connected?provider=gcal&status=ok');
    expect(saveConnectionMock).toHaveBeenCalledTimes(1);
    expect(noticeMock.mock.calls[0]?.[1]).toMatchObject({ provider: 'gcal' });
    expect(noticeMock.mock.calls[0]?.[1]).not.toHaveProperty('fromBundle');
  });
});
