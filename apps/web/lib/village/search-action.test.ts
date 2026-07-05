import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The season-search Server Action: auth-gate → rate-limit (paid run, so a real
 * cooldown, unlike the unthrottled standing findActivitiesAction) → season-scoped
 * discovery → revalidate. A limiter denial must return a STRUCTURED
 * { status: 'rate_limited', retryAfter } — never a bare throw or a swallowed null
 * (rule #8) — and must NOT run the billable discovery.
 */

const authConfiguredMock = vi.fn();
const authMock = vi.fn();
const resolveFamilyMock = vi.fn();
const rateLimitStatusMock = vi.fn();
const discoverMock = vi.fn();
const revalidateMock = vi.fn();
const flushMock = vi.fn();

vi.mock('~/lib/auth-config', () => ({ authConfigured: () => authConfiguredMock() }));
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: (...a: unknown[]) => resolveFamilyMock(...a),
}));
vi.mock('~/lib/rate-limit/apply', () => ({
  rateLimitStatus: (...a: unknown[]) => rateLimitStatusMock(...a),
}));
vi.mock('./discover', () => ({
  discoverForFamily: (...a: unknown[]) => discoverMock(...a),
  defaultDiscoverDeps: () => ({ __deps: true }),
}));
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidateMock(...a) }));
vi.mock('~/lib/telemetry/langfuse', () => ({ flushTelemetry: () => flushMock() }));

async function call(season: string) {
  const { searchActivitiesForSeasonAction } = await import('./search-action');
  return searchActivitiesForSeasonAction(season as never);
}

describe('searchActivitiesForSeasonAction', () => {
  beforeEach(() => {
    vi.resetModules();
    authConfiguredMock.mockReset().mockReturnValue(true);
    authMock.mockReset().mockResolvedValue({ user: { id: 'ext-1' } });
    resolveFamilyMock.mockReset().mockResolvedValue('fam-1');
    rateLimitStatusMock.mockReset().mockResolvedValue({ allowed: true, retryAfterSec: 0 });
    discoverMock.mockReset().mockResolvedValue({ status: 'discovered', insertedCount: 3 });
    revalidateMock.mockReset();
    flushMock.mockReset().mockResolvedValue(undefined);
  });

  it('rejects an invalid season before auth/limiter/discovery', async () => {
    const res = await call('autumn');
    expect(res).toEqual({ status: 'invalid_season' });
    expect(authMock).not.toHaveBeenCalled();
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it('refuses (unauthenticated) when auth is not configured — no spend', async () => {
    authConfiguredMock.mockReturnValue(false);
    const res = await call('fall');
    expect(res).toEqual({ status: 'unauthenticated' });
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it('refuses (unauthenticated) for a signed-out caller — no spend', async () => {
    authMock.mockResolvedValue(null);
    const res = await call('fall');
    expect(res).toEqual({ status: 'unauthenticated' });
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it('returns no_family when the caller has no resolved family — no spend', async () => {
    resolveFamilyMock.mockResolvedValue(null);
    const res = await call('fall');
    expect(res).toEqual({ status: 'no_family' });
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it('returns rate_limited (structured, with retryAfter) and never runs discovery when over the cap', async () => {
    rateLimitStatusMock.mockResolvedValue({ allowed: false, retryAfterSec: 900 });

    const res = await call('fall');

    expect(res).toEqual({ status: 'rate_limited', retryAfter: 900 });
    expect(rateLimitStatusMock).toHaveBeenCalledWith('village-search', 'fam-1');
    expect(discoverMock).not.toHaveBeenCalled();
  });

  it('runs season-scoped discovery under the cap and revalidates', async () => {
    const res = await call('fall');

    expect(res).toEqual({ status: 'discovered', insertedCount: 3 });
    expect(discoverMock).toHaveBeenCalledWith('fam-1', expect.anything(), expect.anything(), {
      searchSeason: 'fall',
    });
    expect(revalidateMock).toHaveBeenCalledWith('/village');
    expect(flushMock).toHaveBeenCalled();
  });
});
