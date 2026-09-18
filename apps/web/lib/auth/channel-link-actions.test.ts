import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Where a redeemed text link lands. Before the deep link there was one answer and
 * therefore nothing to clamp; now the link names a provider, so the destination is an
 * ALLOWLISTED path built from it and never a string off the query — an unknown `to`
 * falls back to the surface the flow has always had.
 */

const signInMock = vi.fn();

vi.mock('~/auth', () => ({ signIn: (...a: unknown[]) => signInMock(...a) }));
// next-auth's entrypoint pulls `next/server` through an export map vitest cannot
// resolve; the action only needs the error class it narrows on.
vi.mock('next-auth', () => ({ AuthError: class AuthError extends Error {} }));
vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));

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
