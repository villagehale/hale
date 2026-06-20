import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads the Auth.js session + db + the Ask Hale agent at request time.
// We stub those edges so the test exercises the route's auth/spend gating (rule
// #4 / #1) and the answer + conversationId wiring — NOT the real model. Rule #8
// forbids mocking the LLM for AGENT-BEHAVIOUR tests; that contract is covered by
// the coach eval (real cached Claude). This route test asserts orchestration: who
// is allowed to spend, and that a successful call is persisted + recorded.
const authMock = vi.fn();
const askHaleMock = vi.fn();
const recordCoachRunMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: vi.fn(async () => 'fam-1'),
  resolveUserIdForUser: vi.fn(async () => 'user-1'),
}));
vi.mock('~/lib/coach/agent', () => ({ askHale: (...a: unknown[]) => askHaleMock(...a) }));
vi.mock('~/lib/coach/record-run', () => ({
  recordCoachRun: (...a: unknown[]) => recordCoachRunMock(...a),
}));

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

function session(externalAuthId: string | null) {
  return externalAuthId ? { user: { id: externalAuthId } } : null;
}

async function callPost(body: unknown) {
  const { POST } = await import('~/app/api/coach/route');
  return POST(
    new Request('http://localhost/api/coach', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/coach — auth + spend gating', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    askHaleMock.mockReset();
    recordCoachRunMock.mockReset().mockResolvedValue('run-1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 501 and NEVER runs the agent when auth is unconfigured (no spend)', async () => {
    configureAuth(false);

    const res = await callPost({ question: 'how much should a newborn sleep?' });

    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
    expect(askHaleMock).not.toHaveBeenCalled();
  });

  it('returns 401 when configured but the caller is not signed in', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session(null));

    const res = await callPost({ question: 'is this normal?' });

    expect(res.status).toBe(401);
    expect(askHaleMock).not.toHaveBeenCalled();
  });

  it('returns 400 on an empty question before any agent run', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google-1'));

    const res = await callPost({ question: '   ' });

    expect(res.status).toBe(400);
    expect(askHaleMock).not.toHaveBeenCalled();
  });

  it('runs the agent family-scoped, persists, records the run, and returns the answer + conversationId', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google-1'));
    askHaleMock.mockResolvedValue({
      answer: 'teens pull away — that is developmentally on time.',
      conversationId: 'conv-7',
      metrics: { modelUsed: 'm', promptTokens: 1, completionTokens: 1, costUsd: 0.001, latencyMs: 5 },
    });

    const res = await callPost({
      question: 'my teen barely talks to me anymore',
      conversationId: '44444444-4444-4444-8444-444444444444',
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    // Family-scoped + acting parent is the audit actor (rule #6).
    expect(askHaleMock).toHaveBeenCalledWith(
      {
        familyId: 'fam-1',
        question: 'my teen barely talks to me anymore',
        intent: null,
        conversationId: '44444444-4444-4444-8444-444444444444',
        actor: 'user-1',
      },
      expect.anything(),
    );
    expect(recordCoachRunMock).toHaveBeenCalledWith(
      'fam-1',
      expect.objectContaining({ costUsd: 0.001 }),
      expect.anything(),
    );
    expect(body.body).toContain('teens pull away');
    expect(body.conversationId).toBe('conv-7');
  });
});
