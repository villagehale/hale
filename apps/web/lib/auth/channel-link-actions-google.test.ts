import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * VIL-721 · where a tap on the ONE Google link lands. Lit, `to=google` goes straight
 * into the one consent for Gmail and the calendar; dark it names nothing this
 * deployment mints and lands on the family page like any unknown target. A dead link
 * gets a fresh ONE link, never the two.
 */

const signInMock = vi.fn();
const recallMock = vi.fn();
const freshMock = vi.fn();

vi.mock('~/auth', () => ({ signIn: (...a: unknown[]) => signInMock(...a) }));
// next-auth's entrypoint pulls `next/server` through an export map vitest cannot
// resolve; the action only needs the error class it narrows on.
vi.mock('next-auth', () => ({
  AuthError: class AuthError extends Error {
    type = 'CredentialsSignin';
  },
}));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/auth/channel-signin', () => ({
  recallChannelSigninParent: (...a: unknown[]) => recallMock(...a),
}));
vi.mock('~/lib/channel/connect/fresh-link', () => ({
  textFreshConnectorLink: (...a: unknown[]) => freshMock(...a),
}));

const TOKEN_ID = '55555555-5555-4555-8555-555555555555';

async function redeem(token: string, to: string | null) {
  const { redeemChannelLinkAction } = await import('./channel-link-actions');
  const state = await redeemChannelLinkAction(token, to, { status: 'idle' }, new FormData()).catch(
    () => undefined,
  );
  return {
    signedIn: signInMock.mock.calls[0]?.[1] as { token: string; redirectTo: string } | undefined,
    state,
  };
}

describe('redeemChannelLinkAction — the one Google link (VIL-721)', () => {
  beforeEach(() => {
    vi.resetModules();
    signInMock.mockReset();
    signInMock.mockResolvedValue(undefined);
    recallMock.mockReset();
    recallMock.mockResolvedValue(null);
    freshMock.mockReset();
    freshMock.mockResolvedValue('sent');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('lit, sends the tap into the one consent and carries the link id to burn', async () => {
    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'true');
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    recallMock.mockResolvedValue({
      userId: 'user',
      familyId: 'family',
      tokenId: TOKEN_ID,
      usable: true,
    });
    const { signedIn } = await redeem('tok-g', 'google');
    expect(signedIn).toEqual({
      token: 'tok-g',
      redirectTo: `/api/integrations/google/connect?from=text&link=${TOKEN_ID}`,
    });
  });

  it('lit, without a recalled link id, still goes to the one consent', async () => {
    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'true');
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    const { signedIn } = await redeem('tok-g', 'google');
    expect(signedIn).toEqual({
      token: 'tok-g',
      redirectTo: '/api/integrations/google/connect?from=text',
    });
  });

  it('dark, lands on the family page: no consent starts from a link nothing mints', async () => {
    const { signedIn } = await redeem('tok-g', 'google');
    expect(signedIn).toEqual({ token: 'tok-g', redirectTo: '/family' });
  });

  it('lit, texts a fresh ONE link for a dead one, and opens nothing', async () => {
    vi.stubEnv('THREAD_ONBOARDING_V2_ENABLED', 'true');
    vi.stubEnv('COLD_START_LADDER_ENABLED', 'true');
    recallMock.mockResolvedValue({
      userId: 'user',
      familyId: 'family',
      tokenId: TOKEN_ID,
      usable: false,
    });
    const { signedIn, state } = await redeem('tok-dead', 'google');
    expect(signedIn).toBeUndefined();
    expect(freshMock).toHaveBeenCalledTimes(1);
    expect(freshMock.mock.calls[0]?.[1]).toMatchObject({
      familyId: 'family',
      parentUserId: 'user',
      provider: 'google',
    });
    expect(state).toEqual({
      status: 'error',
      message: 'This link is invalid or has expired. A fresh one is in your texts.',
    });
  });

  it('dark, mints no fresh link for a dead google link', async () => {
    recallMock.mockResolvedValue({
      userId: 'user',
      familyId: 'family',
      tokenId: TOKEN_ID,
      usable: false,
    });
    await redeem('tok-dead', 'google');
    expect(freshMock).not.toHaveBeenCalled();
  });
});
