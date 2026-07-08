import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The map-image route auth-gates, then STREAMS a Static Maps thumbnail so the server
// Maps key never reaches the client. The family-scoped candidate read lives behind
// readCandidateVenuePoint (a shared lib) — the route itself holds no db handle
// (rule #1). Any non-200 upstream → 204 ("no map"), so the thumbnail simply appears
// once the API is enabled (no release). We stub the venue read + fetch at the
// boundary — never a live Google call, never a real DB.
const authMock = vi.fn();
const readVenuePointMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/village/map-image', async (importActual) => {
  const actual = await importActual<typeof import('~/lib/village/map-image')>();
  return { ...actual, readCandidateVenuePoint: (...a: unknown[]) => readVenuePointMock(...a) };
});

const CANDIDATE_ID = '44444444-4444-4444-8444-444444444444';

async function callGet(candidateId = CANDIDATE_ID): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/village/map-image/route');
  return GET(
    new Request(`http://localhost/api/mobile/village/map-image?candidateId=${candidateId}`),
  );
}

describe('GET /api/mobile/village/map-image', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    readVenuePointMock.mockReset();
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    readVenuePointMock.mockResolvedValue({ lat: 43.65, lng: -79.38 });
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'test-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('returns 204 (no map) when the upstream Static Maps API responds 403 (not enabled)', async () => {
    // The exact scenario for launch: the API is not yet activated on the project.
    const fetchMock = vi.fn().mockResolvedValue(new Response('not activated', { status: 403 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await callGet();

    expect(res.status).toBe(204);
    // The client treats any non-200 as "no map" and renders nothing.
    expect(await res.text()).toBe('');
    // We DID attempt the upstream (so a real enablement flips it to 200 with no code change).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('streams the image bytes on a 200 upstream (and never exposes the key to the client)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('PNGBYTES', { status: 200, headers: { 'content-type': 'image/png' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toBe('PNGBYTES');
    // The client-facing response body/headers carry no key; the key lived only in
    // the (server-side) request URL passed to fetch.
    const requestedUrl = String(fetchMock.mock.calls[0]?.[0]);
    expect(requestedUrl).toContain('key=test-key');
  });

  it('returns 204 without calling fetch when the candidate has no venue point (teen-redacted or online activity)', async () => {
    readVenuePointMock.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await callGet();

    expect(res.status).toBe(204);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 401 for a signed-out caller', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
  });
});
