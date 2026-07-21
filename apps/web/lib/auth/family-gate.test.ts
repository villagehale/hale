import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The post-auth family gate lives in the authed layout: a signed-in parent with NO
 * family (onboarding incomplete) is bounced to /onboarding from ANY authed route,
 * while a parent WITH a family passes through to the app. A signed-out request is
 * sent to /sign-in. This exercises that real gate — the layout's own branching —
 * with the DB-touching family lookup and the app-shell render stubbed at their
 * seams.
 *
 * `redirect` throws (as Next's does) so the gate's decision halts the function; a
 * PASSED gate instead reaches the first downstream loader, which throws a distinct
 * sentinel — so "passed" and "redirected" are unambiguous and a redirect can never
 * be silently swallowed by the render.
 */

const { auth, resolveFamilyForUser, redirect } = vi.hoisted(() => ({
  auth: vi.fn(),
  resolveFamilyForUser: vi.fn(),
  redirect: vi.fn((target: string) => {
    throw new Error(`REDIRECT:${target}`);
  }),
}));

vi.mock('~/lib/auth-config', () => ({ authConfigured: () => true }));
vi.mock('~/auth', () => ({ auth }));
vi.mock('~/lib/family', () => ({ resolveFamilyForUser, loadViewerName: vi.fn(async () => null) }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('next/navigation', () => ({ redirect }));
vi.mock('next/server', () => ({ after: vi.fn() }));

// Sentinel: a passed gate reaches the layout's Promise.all — the first loader throws
// so the test never renders the real app shell. A redirect would have thrown first.
vi.mock('~/lib/dashboard/queries', () => ({
  loadFamilyBasics: () => {
    throw new Error('GATE_PASSED');
  },
}));
vi.mock('~/lib/dashboard/notifications', () => ({ loadNotifications: async () => ({}) }));
vi.mock('~/lib/village/switcher', () => ({ loadAreaSwitcher: async () => ({}) }));

import AuthedLayout from '~/app/(authed)/layout';

const run = () =>
  (AuthedLayout as unknown as (p: { children: unknown }) => Promise<unknown>)({ children: null });

const FAMILY_ID = '55555555-5555-4555-8555-555555555555';

beforeEach(() => {
  vi.clearAllMocks();
  redirect.mockImplementation((target: string) => {
    throw new Error(`REDIRECT:${target}`);
  });
});

describe('authed layout — the post-auth family gate', () => {
  it('redirects a signed-in parent with NO family into onboarding', async () => {
    auth.mockResolvedValue({ user: { id: 'google-sub-new' } });
    resolveFamilyForUser.mockResolvedValue(null);

    await expect(run()).rejects.toThrow('REDIRECT:/onboarding');
    expect(redirect).toHaveBeenCalledWith('/onboarding');
  });

  it('lets a returning parent WITH a family pass through to the app', async () => {
    auth.mockResolvedValue({ user: { id: 'google-sub-returning' } });
    resolveFamilyForUser.mockResolvedValue(FAMILY_ID);

    // Passed the gate → reaches the downstream loader sentinel, never /onboarding.
    await expect(run()).rejects.toThrow('GATE_PASSED');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects a signed-out request to sign-in', async () => {
    auth.mockResolvedValue(null);

    await expect(run()).rejects.toThrow('REDIRECT:/sign-in');
    expect(redirect).toHaveBeenCalledWith('/sign-in');
    expect(resolveFamilyForUser).not.toHaveBeenCalled();
  });
});
