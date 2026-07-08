import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile "mark done" write reuses the EXACT lib the web markCompanionItemDone
// server action uses: buildDoneEpisodeInsert (kept REAL so the row shape — and thus
// the audit row's actionTaken=`quick_log_${episodeType}` — is proven preserved) +
// writeEpisode (mocked to assert the exact args) + childBelongsToFamily (rule #1
// fail-closed). The time is server-clocked (a done-tap is "confirmed done today").
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
      throw new Error('mobile companion done route must NOT construct its own db (rule #1)');
    },
  };
});

const FAMILY_ID = 'fam-1';
const AUTHOR_ID = 'user-1';
const CHILD_ID = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-07-02T12:00:00.000Z');

async function callPost(body: unknown): Promise<Response> {
  const { POST } = await import('~/app/api/mobile/companion/done/route');
  return POST(
    new Request('http://localhost/api/mobile/companion/done', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/mobile/companion/done', () => {
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
    currentFamilyIdMock.mockResolvedValue(FAMILY_ID);
    resolveUserIdMock.mockResolvedValue(AUTHOR_ID);
    childBelongsMock.mockResolvedValue(true);
    writeEpisodeMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never writes', async () => {
    authMock.mockResolvedValue(null);

    const res = await callPost({ target: 'health', childId: CHILD_ID, what: 'x', healthKey: '4-well_child_visit' });

    expect(res.status).toBe(401);
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid body and never writes', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({ target: 'health', childId: CHILD_ID });

    expect(res.status).toBe(400);
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('returns 403 when the child does not belong to the family and never writes', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });
    childBelongsMock.mockResolvedValue(false);

    const res = await callPost({
      target: 'health',
      childId: CHILD_ID,
      what: '4-month well-baby visit',
      healthKey: '4-well_child_visit',
    });

    expect(res.status).toBe(403);
    expect(writeEpisodeMock).not.toHaveBeenCalled();
  });

  it('writes the exact audited health_done episode row and returns 201', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callPost({
      target: 'health',
      childId: CHILD_ID,
      what: '4-month well-baby visit',
      healthKey: '4-well_child_visit',
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ status: 'done' });
    expect(childBelongsMock).toHaveBeenCalledWith(DB_HANDLE, FAMILY_ID, CHILD_ID);
    expect(resolveUserIdMock).toHaveBeenCalledWith('ext-1', DB_HANDLE);
    // Derived from buildDoneEpisodeInsert's health branch + the audited-write
    // contract (episodeType 'health_done' drives actionTaken=quick_log_health_done),
    // NOT copied from route output.
    expect(writeEpisodeMock).toHaveBeenCalledWith(DB_HANDLE, {
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      authoredBy: AUTHOR_ID,
      occurredAt: NOW,
      episodeType: 'health_done',
      summary: '4-month well-baby visit — done',
      payload: { healthKey: '4-well_child_visit', what: '4-month well-baby visit' },
    });
  });
});
