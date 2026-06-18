import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route reads the Auth.js session + db + the coach LLM call at request time.
// We stub those edges so the test exercises the route's auth/spend gating (hard
// rule #4 / #1) and the answer wiring — NOT the real model. Hard rule #8 forbids
// mocking the LLM for AGENT-BEHAVIOUR tests; that contract is covered by the coach
// eval (run-coach-eval.mjs, real cached Claude). This route test asserts
// orchestration: who is allowed to spend, and that a successful call is recorded.
const authMock = vi.fn();
const askCoachMock = vi.fn();
const loadFamilyStagesMock = vi.fn();
const recordCoachRunMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: vi.fn(async () => 'fam-1'),
}));
vi.mock('~/lib/coach/coach', () => ({ askCoach: (...a: unknown[]) => askCoachMock(...a) }));
vi.mock('~/lib/coach/family-stages', () => ({
  loadFamilyStages: (...a: unknown[]) => loadFamilyStagesMock(...a),
}));
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
    askCoachMock.mockReset();
    loadFamilyStagesMock.mockReset().mockResolvedValue(['newborn']);
    recordCoachRunMock.mockReset().mockResolvedValue('run-1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 501 and NEVER calls the model when auth is unconfigured (no spend)', async () => {
    configureAuth(false);

    const res = await callPost({ question: 'how much should a newborn sleep?' });

    expect(res.status).toBe(501);
    expect(authMock).not.toHaveBeenCalled();
    expect(askCoachMock).not.toHaveBeenCalled();
  });

  it('returns 401 when configured but the caller is not signed in', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session(null));

    const res = await callPost({ question: 'is this normal?' });

    expect(res.status).toBe(401);
    expect(askCoachMock).not.toHaveBeenCalled();
  });

  it('returns 400 on an empty question before any model call', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google-1'));

    const res = await callPost({ question: '   ' });

    expect(res.status).toBe(400);
    expect(askCoachMock).not.toHaveBeenCalled();
  });

  it('asks the coach with ONLY the caller-family stages, records the run, and shapes the answer', async () => {
    configureAuth(true);
    authMock.mockResolvedValue(session('google-1'));
    loadFamilyStagesMock.mockResolvedValue(['teenager']);
    askCoachMock.mockResolvedValue({
      answer: {
        adviceText: 'teens pull away — that is developmentally on time.',
        frameworkCitations: [{ framework: 'siegel', reference: 'The Whole-Brain Child, ch. 9' }],
        confidence: 0.82,
        followUpQuestions: ['is the change sudden or gradual?'],
        flagForPediatrician: false,
      },
      metrics: { modelUsed: 'm', promptTokens: 1, completionTokens: 1, costUsd: 0.001, latencyMs: 5 },
    });

    const res = await callPost({ question: 'my teen barely talks to me anymore' });
    const body = await res.json();

    expect(res.status).toBe(200);
    // Family-scoped: the coach received the caller-family stages, no raw child data.
    expect(askCoachMock).toHaveBeenCalledWith({
      question: 'my teen barely talks to me anymore',
      stages: ['teenager'],
    });
    expect(recordCoachRunMock).toHaveBeenCalledWith(
      'fam-1',
      expect.objectContaining({ costUsd: 0.001 }),
      expect.anything(),
    );
    expect(body.body).toContain('teens pull away');
    // Citation rendered in the string[] shape the UI expects, with the framework label.
    expect(body.citations).toEqual(['siegel · The Whole-Brain Child — The Whole-Brain Child, ch. 9']);
    expect(body.followUps).toEqual(['is the change sudden or gradual?']);
  });
});
