import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/companion/logs — the dedicated logs view's page fetcher (filter switch
 * + load-more). Auth is the gate (rule #1): dev-preview refuses with 501,
 * signed-out with 401, a user with no family with 403. It NEVER returns another
 * family's logs — readLogsPage is family-scoped and teen-redacted. The edges
 * (auth/db/family + the page reader) are stubbed so the test asserts the
 * auth/family gating + the childId/before pass-through, not infra.
 */

const authMock = vi.fn();
const readLogsPageMock = vi.fn();

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => ({}) }));
vi.mock('~/lib/family', () => ({
  resolveFamilyForUser: vi.fn(async () => 'fam-1'),
  resolveUserIdForUser: vi.fn(async () => 'user-1'),
}));
vi.mock('~/lib/companion/logs-page', () => ({
  readLogsPage: (...a: unknown[]) => readLogsPageMock(...a),
}));

function configureAuth(on: boolean) {
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_ID', on ? 'gid_test' : '');
  vi.stubEnv('GOOGLE_OAUTH_CLIENT_SECRET', on ? 'gsecret_test' : '');
}

function session(externalAuthId: string | null) {
  return externalAuthId ? { user: { id: externalAuthId } } : null;
}

async function callGet(query: string) {
  const { GET } = await import('~/app/api/companion/logs/route');
  return GET(new Request(`http://localhost/api/companion/logs${query}`));
}

beforeEach(() => {
  vi.resetModules();
  authMock.mockReset();
  readLogsPageMock.mockReset();
  configureAuth(true);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/companion/logs — auth + family gating', () => {
  it('refuses with 501 when auth is unconfigured (never reads a page)', async () => {
    configureAuth(false);

    const res = await callGet('');

    expect(res.status).toBe(501);
    expect(readLogsPageMock).not.toHaveBeenCalled();
  });

  it('refuses with 401 when signed out', async () => {
    authMock.mockResolvedValue(session(null));

    const res = await callGet('');

    expect(res.status).toBe(401);
    expect(readLogsPageMock).not.toHaveBeenCalled();
  });

  it('returns the family-scoped page and passes childId + before through', async () => {
    const CHILD_ID = '33333333-3333-4333-8333-333333333333';
    authMock.mockResolvedValue(session('ext-1'));
    readLogsPageMock.mockResolvedValue({
      logs: [
        {
          id: 'e1',
          childId: CHILD_ID,
          episodeType: 'feed',
          summary: 's',
          occurredAt: '2026-06-30T12:00:00.000Z',
        },
      ],
      nextCursor: '2026-06-29T00:00:00.000Z',
    });

    const res = await callGet(`?child=${CHILD_ID}&before=2026-06-30T00:00:00.000Z`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.logs).toHaveLength(1);
    expect(body.nextCursor).toBe('2026-06-29T00:00:00.000Z');

    const [, familyId, requestingUserId, opts] = readLogsPageMock.mock.calls[0] as [
      unknown,
      string,
      string | null,
      Record<string, unknown>,
    ];
    expect(familyId).toBe('fam-1');
    expect(requestingUserId).toBe('user-1');
    expect(opts).toMatchObject({ childId: CHILD_ID, before: '2026-06-30T00:00:00.000Z' });
  });
});
