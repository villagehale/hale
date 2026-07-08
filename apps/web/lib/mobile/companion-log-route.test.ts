import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile quick-log write reuses the EXACT lib the web server action uses:
// buildEpisodeInsert (kept REAL so the row shape — and thus the audit row's
// actionTaken=`quick_log_${episodeType}` — is proven preserved) + writeEpisode
// (mocked to assert the exact args reach it) + childBelongsToFamily (rule #1 fail-
// closed). currentFamilyId resolves the family the same way the action does; db()
// is stubbed to a sentinel so we can assert it's the handle passed downstream.
const authMock = vi.fn();
const currentFamilyIdMock = vi.fn();
const resolveUserIdMock = vi.fn();
const childBelongsMock = vi.fn();
const writeEpisodeMock = vi.fn();
const DB_HANDLE = { __db: true };

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => DB_HANDLE }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: (...a: unknown[]) => currentFamilyIdMock(...a),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));
vi.mock('~/lib/companion/log-write', async (importActual) => {
  const actual = await importActual<typeof import('~/lib/companion/log-write')>();
  return {
    ...actual,
    childBelongsToFamily: (...a: unknown[]) => childBelongsMock(...a),
    writeEpisode: (...a: unknown[]) => writeEpisodeMock(...a),
  };
});

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile companion log route must NOT construct its own db (rule #1)');
    },
  };
});

const FAMILY_ID = 'fam-1';
const AUTHOR_ID = 'user-1';
const CHILD_ID = '11111111-1111-1111-1111-111111111111';
// Fixed clock so occurredAt (defaulted to "now") is deterministic in the assert.
const NOW = new Date('2026-07-02T12:00:00.000Z');

async function callPost(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/companion/log/route');
  return POST(
    new Request('http://localhost/api/mobile/companion/log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/mobile/companion/log', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    authMock.mockReset();
    currentFamilyIdMock.mockReset();
    resolveUserIdMock.mockReset();
    childBelongsMock.mockReset();
    writeEpisodeMock.mockReset();
    vi.stubEnv('DATABASE_URL', 'postgres://test');
    vi.stubEnv('AUTH_SECRET', 'test-secret-mobile-log-route-0123456789abcdef');
    currentFamilyIdMock.mockResolvedValue(FAMILY_ID);
    resolveUserIdMock.mockResolvedValue(AUTHOR_ID);
    childBelongsMock.mockResolvedValue(true);
    writeEpisodeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('returns 503 with no DATABASE_URL and never resolves a family or writes', async () => {
    vi.stubEnv('DATABASE_URL', '');
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ kind: 'feed', childId: CHILD_ID, amountMl: 120 });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'no_database' });
    expect(currentFamilyIdMock).not.toHaveBeenCalled();
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('returns 401 for a signed-out caller and never writes', async () => {
    authMock.mockResolvedValue(null);

    const res = await callPost({ kind: 'feed', childId: CHILD_ID, amountMl: 120 });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid body and never writes', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ kind: 'feed', childId: CHILD_ID, amountMl: -5 });

    expect(res.status).toBe(400);
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the child does not belong to the family and never writes', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    childBelongsMock.mockResolvedValue(false);

    const res = await callPost({ kind: 'feed', childId: CHILD_ID, amountMl: 120 });

    expect(res.status).toBe(403);
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('writes the exact audited feed episode row and returns 201', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({
      kind: 'feed',
      childId: CHILD_ID,
      amountMl: 120,
      feedKind: 'bottle',
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: 'logged' });
    expect(childBelongsMock).toHaveBeenCalledWith(DB_HANDLE, FAMILY_ID, CHILD_ID);
    // The acting parent is resolved from the session's external id and stamped as
    // authoredBy — the rule-#1 parent-authored exemption for teen logs.
    expect(resolveUserIdMock).toHaveBeenCalledWith('ext-1', DB_HANDLE);
    // Derived from buildEpisodeInsert's feed branch + the audited-write contract
    // (episodeType drives the audit row's actionTaken=quick_log_feed), NOT copied
    // from route output.
    expect(writeEpisodeMock).toHaveBeenCalledWith(DB_HANDLE, {
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      authoredBy: AUTHOR_ID,
      occurredAt: NOW,
      episodeType: 'feed',
      summary: 'Fed 120 ml (bottle)',
      payload: { amountMl: 120, feedKind: 'bottle' },
    });
  });

  it('derives a nap duration from a start/end window (server-side, no client math)', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({
      kind: 'nap',
      childId: CHILD_ID,
      startAt: '2026-07-02T09:00:00Z',
      endAt: '2026-07-02T10:30:00Z',
    });

    expect(res.status).toBe(201);
    // 90 min derived from the window; the bounds ride the payload so the window
    // survives (derived value, NOT copied from output — 09:00→10:30 = 90).
    expect(writeEpisodeMock).toHaveBeenCalledWith(DB_HANDLE, {
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      authoredBy: AUTHOR_ID,
      occurredAt: NOW,
      episodeType: 'nap',
      summary: 'Napped 90 min',
      payload: { durationMin: 90, startAt: '2026-07-02T09:00:00Z', endAt: '2026-07-02T10:30:00Z' },
    });
  });

  it('rejects a nap with an end before its start (400, never writes)', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({
      kind: 'nap',
      childId: CHILD_ID,
      startAt: '2026-07-02T10:30:00Z',
      endAt: '2026-07-02T09:00:00Z',
    });

    expect(res.status).toBe(400);
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('rejects a nap with NEITHER a duration nor a window (400 at the route, never writes)', async () => {
    // napSchema's durationMin is now optional, so {kind:'nap', childId} PARSES —
    // resolveNap is what stops it. Without this guard the route would reach
    // buildEpisodeInsert (throws: missing durationMin and window) → an unhandled 500.
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ kind: 'nap', childId: CHILD_ID });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'enter how long the nap was, or its start and end',
    });
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('rejects a nap with a lone start bound (incomplete window, 400, never writes)', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({
      kind: 'nap',
      childId: CHILD_ID,
      startAt: '2026-07-02T09:00:00Z',
    });

    expect(res.status).toBe(400);
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('writes the exact audited measurement episode row (fixed unit, honest summary) and returns 201', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({
      kind: 'measurement',
      childId: CHILD_ID,
      measureKind: 'weight',
      value: 10.4,
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: 'logged' });
    // Derived from buildEpisodeInsert's measurement branch + the fixed kg unit
    // (MEASURE_META, never client-sent) — NOT copied from output. The audit row's
    // actionTaken becomes quick_log_measurement from this episodeType.
    expect(writeEpisodeMock).toHaveBeenCalledWith(DB_HANDLE, {
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      authoredBy: AUTHOR_ID,
      occurredAt: NOW,
      episodeType: 'measurement',
      summary: 'Weighed 10.4 kg',
      payload: { measureKind: 'weight', value: 10.4, unit: 'kg' },
    });
  });

  it('rejects a measurement over the per-kind ceiling (400 at the boundary, never writes)', async () => {
    // A weight of 55 kg is beyond MEASURE_META.weight.max (40) — a mistype, not a
    // real reading. resolveMeasurement stops it at the route before any write.
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({
      kind: 'measurement',
      childId: CHILD_ID,
      measureKind: 'weight',
      value: 55,
    });

    expect(res.status).toBe(400);
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });
});
