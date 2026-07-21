import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The pre-auth onboarding city typeahead is a GET route handler (not a Server Action)
 * so debounced keystroke lookups run in PARALLEL instead of serializing behind each
 * other the way Next queues a client's action POSTs (WP-12). We assert: predictions
 * come back with the session token threaded; the paid provider is capped per client IP
 * (over the limit → 429, never reaching Places); and a sub-2-char query is a no-op
 * before any rate check or provider call.
 */

const searchMock = vi.fn();
const rateLimitMock = vi.fn();

vi.mock('~/lib/village/geocode', () => ({
  autocompleteCanadianCities: (...a: unknown[]) => searchMock(...a),
}));
vi.mock('~/lib/rate-limit/apply', () => ({
  enforceRateLimit: (...a: unknown[]) => rateLimitMock(...a),
  clientIp: () => '203.0.113.5',
}));

async function callGet(url: string): Promise<Response> {
  const { GET } = await import('~/app/api/onboarding/city-search/route');
  return GET(new Request(url));
}

beforeEach(() => {
  vi.resetModules();
  searchMock
    .mockReset()
    .mockResolvedValue([
      { placeId: 'p1', city: 'Toronto', province: 'ON', description: 'Toronto, ON, Canada' },
    ]);
  rateLimitMock.mockReset().mockResolvedValue(null);
});

describe('GET /api/onboarding/city-search', () => {
  it('returns predictions, threading the session token, capped per client IP', async () => {
    const res = await callGet('http://localhost/api/onboarding/city-search?q=toron&session=sess-9');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      predictions: [{ placeId: 'p1', city: 'Toronto', province: 'ON', description: 'Toronto, ON, Canada' }],
    });
    expect(searchMock).toHaveBeenCalledWith('toron', 'sess-9');
    expect(rateLimitMock).toHaveBeenCalledWith('city-search', '203.0.113.5');
  });

  it('is a no-op for a sub-2-char query (no rate check, no provider call)', async () => {
    const res = await callGet('http://localhost/api/onboarding/city-search?q=t');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ predictions: [] });
    expect(rateLimitMock).not.toHaveBeenCalled();
    expect(searchMock).not.toHaveBeenCalled();
  });

  it('caps the paid provider: over the limit → 429, never reaching Places', async () => {
    rateLimitMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }),
    );
    const res = await callGet('http://localhost/api/onboarding/city-search?q=toron');
    expect(res.status).toBe(429);
    expect(searchMock).not.toHaveBeenCalled();
  });
});
