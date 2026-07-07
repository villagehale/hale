import { NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Proves the limiter is wired into POST /api/coach: an over-cap decision short-
// circuits BEFORE the billable agent runs. The agent, auth, family resolution and
// db are stubbed (the established route-test idiom — see village/accept-route.test);
// the limiter decision is the variable under test.
const authMock = vi.fn();
const runConciergeMock = vi.fn();
const enforceRateLimitMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: async () => 'fam-1',
  resolveUserIdForUser: async () => 'user-1',
}));
vi.mock('~/lib/coach/agent', () => ({
  runConcierge: (...a: unknown[]) => runConciergeMock(...a),
}));
vi.mock('~/lib/telemetry/langfuse', () => ({ flushTelemetry: async () => {} }));
vi.mock('~/lib/rate-limit/apply', () => ({
  enforceRateLimit: (...a: unknown[]) => enforceRateLimitMock(...a),
}));

async function callPost() {
  const { POST } = await import('~/app/api/coach/route');
  return POST(
    new Request('http://localhost/api/coach', {
      method: 'POST',
      body: JSON.stringify({ question: 'how do I help my toddler sleep?' }),
    }),
  );
}

async function drain(res: Response): Promise<void> {
  // The 200 path streams; consume it so the controller closes and runConcierge runs.
  await res.text();
}

describe('POST /api/coach — rate limiting', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    runConciergeMock.mockReset();
    enforceRateLimitMock.mockReset();
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    runConciergeMock.mockResolvedValue({ conversationId: 'c1', actionIntents: [] });
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', 'gid_test');
    vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', 'gsecret_test');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the limiter 429 and never runs the agent when over the cap', async () => {
    enforceRateLimitMock.mockResolvedValue(
      NextResponse.json({ error: 'rate_limited' }, { status: 429, headers: { 'Retry-After': '30' } }),
    );

    const res = await callPost();

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(runConciergeMock).not.toHaveBeenCalled();
    expect(enforceRateLimitMock).toHaveBeenCalledWith('coach', 'user-1');
  });

  it('runs the agent when under the cap', async () => {
    enforceRateLimitMock.mockResolvedValue(null);

    const res = await callPost();
    await drain(res);

    expect(res.status).toBe(200);
    expect(runConciergeMock).toHaveBeenCalledOnce();
  });
});
