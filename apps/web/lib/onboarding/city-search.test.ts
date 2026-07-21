import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * resolveCityAction — the pre-auth onboarding city SELECTION action (the typeahead now
 * lives in GET /api/onboarding/city-search, WP-12). It reaches the PAID Places provider
 * to resolve a picked place to its centroid, so it is capped per CLIENT IP (the only
 * identifier before sign-in) and threads the search session's token. We assert: the IP
 * is read from the first x-forwarded-for hop; over the cap yields an honest rate_limited
 * status and NEVER calls the provider; and the token threads to the geocode seam.
 */

const headersMock = vi.fn();
const rateLimitMock = vi.fn();
const resolveMock = vi.fn();

vi.mock('next/headers', () => ({ headers: () => headersMock() }));
vi.mock('~/lib/rate-limit/apply', () => ({
  rateLimitStatus: (...a: unknown[]) => rateLimitMock(...a),
}));
vi.mock('~/lib/village/geocode', () => ({
  resolveCityPlace: (...a: unknown[]) => resolveMock(...a),
}));

import { resolveCityAction } from '~/lib/onboarding/city-search';

beforeEach(() => {
  headersMock.mockReset().mockReturnValue({
    get: (h: string) => (h === 'x-forwarded-for' ? '203.0.113.5, 10.0.0.1' : null),
  });
  rateLimitMock.mockReset().mockResolvedValue({ allowed: true, retryAfterSec: 0 });
  resolveMock
    .mockReset()
    .mockResolvedValue({ city: 'Toronto', province: 'ON', lat: 43.6, lng: -79.4 });
});

describe('resolveCityAction — resolve a picked place, capped per client IP, token threaded', () => {
  it('returns the centroid, caps per the first x-forwarded-for hop, threads the token', async () => {
    expect(await resolveCityAction('p1', 'sess-1')).toEqual({
      status: 'ok',
      centroid: { city: 'Toronto', province: 'ON', lat: 43.6, lng: -79.4 },
    });
    expect(rateLimitMock).toHaveBeenCalledWith('city-search', '203.0.113.5');
    expect(resolveMock).toHaveBeenCalledWith('p1', 'sess-1');
  });

  it('rate_limits without calling the provider when over the cap', async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSec: 30 });
    expect(await resolveCityAction('p1', 'sess-1')).toEqual({ status: 'rate_limited' });
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('is a no-op for an empty place id (no rate check, no provider call)', async () => {
    expect(await resolveCityAction('  ', 'sess-1')).toEqual({ status: 'ok', centroid: null });
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
