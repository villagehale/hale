import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route runs the no-DB preview discovery for an ANONYMOUS visitor. We stub
// the discovery edge (rule #8 forbids mocking the LLM for AGENT-BEHAVIOUR tests —
// that contract is the discovery eval; this route test asserts ORCHESTRATION:
// input validation, the per-IP spend cap, and that only coarse fields reach
// discovery) and the rate limiter (so no real Postgres is touched).
const discoverPreviewMock = vi.fn();
const enforceRateLimitMock = vi.fn();

vi.mock('~/lib/village/preview', () => ({
  discoverPreview: (...a: unknown[]) => discoverPreviewMock(...a),
  defaultPreviewDeps: () => ({ deps: 'fake' }),
}));
vi.mock('~/lib/rate-limit/apply', () => ({
  enforceRateLimit: (...a: unknown[]) => enforceRateLimitMock(...a),
  clientIp: () => '203.0.113.7',
}));

async function callPost(body: unknown) {
  const { POST } = await import('~/app/api/preview/route');
  return POST(
    new Request('http://localhost/api/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/preview — pre-auth value sample (rule #1)', () => {
  beforeEach(() => {
    vi.resetModules();
    discoverPreviewMock.mockReset();
    enforceRateLimitMock.mockReset();
    // Default: under the cap.
    enforceRateLimitMock.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 400 and never calls discovery on a missing body', async () => {
    const res = await callPost(undefined);
    expect(res.status).toBe(400);
    expect(discoverPreviewMock).not.toHaveBeenCalled();
    expect(enforceRateLimitMock).not.toHaveBeenCalled();
  });

  it('returns 400 on an unknown stage (a client can not inject an arbitrary value)', async () => {
    const res = await callPost({ stage: 'adult', areaCoarse: 'M5V', interests: [] });
    expect(res.status).toBe(400);
    expect(discoverPreviewMock).not.toHaveBeenCalled();
  });

  it('returns 400 on an empty coarse area', async () => {
    const res = await callPost({ stage: 'toddler', areaCoarse: '   ', interests: [] });
    expect(res.status).toBe(400);
    expect(discoverPreviewMock).not.toHaveBeenCalled();
  });

  it('returns 429 and never calls discovery when over the per-IP cap (no spend)', async () => {
    enforceRateLimitMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited' }), { status: 429 }),
    );

    const res = await callPost({ stage: 'toddler', areaCoarse: 'M5V', interests: [] });

    expect(res.status).toBe(429);
    expect(discoverPreviewMock).not.toHaveBeenCalled();
  });

  it('passes ONLY coarse fields to discovery, normalizes intents, and returns the sample', async () => {
    discoverPreviewMock.mockResolvedValue([
      { title: 'Story-time', summary: 'a library hour', coverageNote: 'libraries run these', sourceUrl: null },
    ]);

    const res = await callPost({
      stage: 'toddler',
      areaCoarse: '  M5V  ',
      // 'groceries' is not a known intent — it must be dropped; 'activities' is
      // sent twice and must be de-duplicated by parseIntents.
      interests: ['activities', 'groceries', 'activities', 'health'],
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      activities: [
        { title: 'Story-time', summary: 'a library hour', coverageNote: 'libraries run these', sourceUrl: null },
      ],
    });

    // The cap is enforced per-IP BEFORE the billable call.
    expect(enforceRateLimitMock).toHaveBeenCalledWith('preview', '203.0.113.7');

    // Discovery receives only the coarse stage + trimmed area + normalized
    // interests — no name, DOB, precise address, or familyId (rule #1). The
    // unknown 'groceries' is dropped and the duplicate 'activities' collapsed.
    const [input] = discoverPreviewMock.mock.calls[0] ?? [];
    expect(input.stage).toBe('toddler');
    expect(input.areaCoarse).toBe('M5V');
    expect(input.interests).toEqual(['activities', 'health']);
    expect(input).not.toHaveProperty('familyId');
    expect(input).not.toHaveProperty('childNames');
    expect(input).not.toHaveProperty('dateOfBirth');
  });
});
