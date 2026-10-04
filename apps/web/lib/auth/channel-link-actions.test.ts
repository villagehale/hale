import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where a redeemed text link lands. Before the deep link there was one answer and
 * therefore nothing to clamp; now the link names a provider, so the destination is an
 * ALLOWLISTED path built from it and never a string off the query — an unknown `to`
 * falls back to the surface the flow has always had.
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

/** signIn redirects on success; here it resolves, so the action falls through to its
 * own `redirect` — which throws. The assertion subject is the call, not the throw. */
async function redeem(token: string, provider: string | null) {
  const { redeemChannelLinkAction } = await import('./channel-link-actions');
  await redeemChannelLinkAction(token, provider, { status: 'idle' }, new FormData()).catch(
    () => undefined,
  );
  return signInMock.mock.calls[0]?.[1] as { token: string; redirectTo: string } | undefined;
}

describe('redeemChannelLinkAction — the destination the tap earns', () => {
  beforeEach(() => {
    vi.resetModules();
    signInMock.mockReset();
    signInMock.mockResolvedValue(undefined);
    recallMock.mockReset();
    recallMock.mockResolvedValue(null);
    freshMock.mockReset();
    freshMock.mockResolvedValue('sent');
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends a calendar link straight into Google consent, with no portal in between', async () => {
    expect(await redeem('tok-1', 'gcal')).toEqual({
      token: 'tok-1',
      redirectTo: '/api/integrations/gcal/connect?from=text',
    });
  });

  it('sends a Gmail link to the Gmail consent', async () => {
    expect(await redeem('tok-2', 'gmail')).toEqual({
      token: 'tok-2',
      redirectTo: '/api/integrations/gmail/connect?from=text',
    });
  });

  it('keeps the old Settings destination when the link names no provider', async () => {
    expect(await redeem('tok-3', null)).toEqual({ token: 'tok-3', redirectTo: '/settings#apps' });
  });

  /**
   * THE ALLOWLIST LIVES HERE, not only on the page that renders the button. A bound
   * server-action argument round-trips through the client, so `provider` arrives as
   * whatever the browser sends it back as — and the destination is built by string
   * concatenation. The narrowing at this boundary is what keeps that a closed set
   * rather than a path a caller writes.
   */
  it('carries a usable token id into Google consent and does not mint another link', async () => {
    recallMock.mockResolvedValue({
      userId: 'user',
      familyId: 'family',
      tokenId: '44444444-4444-4444-8444-444444444444',
      usable: true,
    });

    expect(await redeem('tok-live', 'gmail')).toEqual({
      token: 'tok-live',
      redirectTo:
        '/api/integrations/gmail/connect?from=text&link=44444444-4444-4444-8444-444444444444',
    });
    expect(freshMock).not.toHaveBeenCalled();
  });

  it('texts a fresh Gmail link when that link is already spent, and does not sign in', async () => {
    recallMock.mockResolvedValue({
      userId: 'user-1',
      familyId: 'family-1',
      tokenId: 'spent',
      usable: false,
    });
    const { redeemChannelLinkAction } = await import('./channel-link-actions');
    const result = await redeemChannelLinkAction(
      'tok-spent',
      'gmail',
      { status: 'idle' },
      new FormData(),
    );

    expect(signInMock).not.toHaveBeenCalled();
    expect(freshMock.mock.calls[0]?.[1]).toMatchObject({
      familyId: 'family-1',
      parentUserId: 'user-1',
      provider: 'gmail',
    });
    expect(result).toEqual({
      status: 'error',
      message: 'This link is invalid or has expired. A fresh one is in your texts.',
    });
    expect(JSON.stringify(result)).not.toContain('connect my calendar');
  });

  it('refuses to build a destination out of anything but a known connector', async () => {
    for (const probe of ['../../sign-out', 'gdrive', '//evil.com', 'gcal ', 'GCAL', '']) {
      signInMock.mockClear();
      expect(await redeem('tok-4', probe)).toEqual({
        token: 'tok-4',
        redirectTo: '/settings#apps',
      });
    }
  });
});
