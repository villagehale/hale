import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pre-auth onboarding city search actions. These reach the PAID Places provider,
 * so they are capped per CLIENT IP (the only identifier before sign-in) and thread the
 * search session's token through autocomplete + the details call (one billed session).
 * We assert: the IP is read from the first x-forwarded-for hop; over the cap yields an
 * honest rate_limited status and NEVER calls the provider; a sub-2-char query is a
 * no-op; and the token threads to the geocode seam.
 */

const headersMock = vi.fn();
const rateLimitMock = vi.fn();
const autocompleteMock = vi.fn();
const resolveMock = vi.fn();

vi.mock('next/headers', () => ({ headers: () => headersMock() }));
vi.mock('~/lib/rate-limit/apply', () => ({
  rateLimitStatus: (...a: unknown[]) => rateLimitMock(...a),
}));
vi.mock('~/lib/village/geocode', () => ({
  autocompleteCanadianCities: (...a: unknown[]) => autocompleteMock(...a),
  resolveCityPlace: (...a: unknown[]) => resolveMock(...a),
}));

import { autocompleteCityAction, resolveCityAction } from '~/lib/onboarding/city-search';

beforeEach(() => {
  headersMock.mockReset().mockReturnValue({
    get: (h: string) => (h === 'x-forwarded-for' ? '203.0.113.5, 10.0.0.1' : null),
  });
  rateLimitMock.mockReset().mockResolvedValue({ allowed: true, retryAfterSec: 0 });
  autocompleteMock
    .mockReset()
    .mockResolvedValue([
      { placeId: 'p1', city: 'Toronto', province: 'ON', description: 'Toronto, ON, Canada' },
    ]);
  resolveMock
    .mockReset()
    .mockResolvedValue({ city: 'Toronto', province: 'ON', lat: 43.6, lng: -79.4 });
});

describe('autocompleteCityAction — pre-auth typeahead, capped per client IP', () => {
  it('returns predictions and caps per the first x-forwarded-for hop, threading the token', async () => {
    const result = await autocompleteCityAction('toron', 'sess-1');
    expect(result).toEqual({
      status: 'ok',
      predictions: [
        { placeId: 'p1', city: 'Toronto', province: 'ON', description: 'Toronto, ON, Canada' },
      ],
    });
    expect(rateLimitMock).toHaveBeenCalledWith('city-search', '203.0.113.5');
    expect(autocompleteMock).toHaveBeenCalledWith('toron', 'sess-1');
  });

  it('returns an honest rate_limited status and never calls the provider when over the cap', async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSec: 30 });
    expect(await autocompleteCityAction('toron', 'sess-1')).toEqual({ status: 'rate_limited' });
    expect(autocompleteMock).not.toHaveBeenCalled();
  });

  it('is a no-op for a sub-2-char query (no rate check, no provider call)', async () => {
    expect(await autocompleteCityAction('t', 'sess-1')).toEqual({ status: 'ok', predictions: [] });
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(autocompleteMock).not.toHaveBeenCalled();
  });
});

describe('resolveCityAction — resolve a picked place, capped, token threaded', () => {
  it('returns the centroid and threads the session token', async () => {
    expect(await resolveCityAction('p1', 'sess-1')).toEqual({
      status: 'ok',
      centroid: { city: 'Toronto', province: 'ON', lat: 43.6, lng: -79.4 },
    });
    expect(resolveMock).toHaveBeenCalledWith('p1', 'sess-1');
  });

  it('rate_limits without calling the provider when over the cap', async () => {
    rateLimitMock.mockResolvedValue({ allowed: false, retryAfterSec: 30 });
    expect(await resolveCityAction('p1', 'sess-1')).toEqual({ status: 'rate_limited' });
    expect(resolveMock).not.toHaveBeenCalled();
  });
});
