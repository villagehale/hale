import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The mobile Companion route mirrors the web companion page's reads (companion
// views + recent logs, which redact teen episodes internally). Auth() gates; the
// loaders own the DB and teen redaction.
const authMock = vi.fn();
const loadCompanionMock = vi.fn();
const loadRecentLogsMock = vi.fn();
vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/companion/queries', () => ({ loadCompanion: () => loadCompanionMock() }));
vi.mock('~/lib/companion/recent-logs', () => ({ loadRecentLogs: () => loadRecentLogsMock() }));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile companion route must NOT touch the database (rule #1)');
    },
  };
});

const CHILDREN = [{ id: 'child-1', name: 'Nadia', stage: 'toddler' }];
const RECENT = [
  {
    id: 'ep-1',
    childId: 'child-1',
    episodeType: 'feed',
    summary: 'Fed 120 ml',
    occurredAt: '2026-07-01T10:00:00.000Z',
  },
];

async function callGet(): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/companion/route');
  return GET();
}

describe('GET /api/mobile/companion', () => {
  beforeEach(() => {
    vi.resetModules();
    authMock.mockReset();
    loadCompanionMock.mockReset();
    loadRecentLogsMock.mockReset();
    loadCompanionMock.mockResolvedValue(CHILDREN);
    loadRecentLogsMock.mockResolvedValue(RECENT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 for a signed-out caller and never calls the loaders', async () => {
    authMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
    expect(loadCompanionMock).not.toHaveBeenCalled();
    expect(loadRecentLogsMock).not.toHaveBeenCalled();
  });

  it('returns the companion views and redacted recent logs for a signed-in parent', async () => {
    authMock.mockResolvedValue({ user: { id: 'ext-1' } });

    const res = await callGet();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ children: CHILDREN, recentLogs: RECENT });
    expect(loadCompanionMock).toHaveBeenCalledTimes(1);
    expect(loadRecentLogsMock).toHaveBeenCalledTimes(1);
  });
});
