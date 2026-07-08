import type { Database } from '@hale/db';
import { getTableName } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * GET /api/mobile/companion/logs — the native glance-detail page fetcher. Auth() is
 * the gate (rule #4): signed-out → 401, a user with no family → 403. It wraps the
 * SHARED readLogsPage, so a 13+ child's rows are dropped by the shared teen
 * redaction (rule #1) and the numerics (durationMin / amountMl / feedKind) are
 * lifted from payload. The redaction case runs the REAL readLogsPage over a fake db
 * — so this test FAILS if the route is ever rewritten to a raw select that skips
 * the shared read.
 */

const authMock = vi.fn();
const currentFamilyIdMock = vi.fn();

interface EpisodeRow {
  id: string;
  childId: string | null;
  authoredBy: string | null;
  episodeType: string;
  summary: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

let dbRows: { children: Array<{ id: string; dateOfBirth: string }>; episodes: EpisodeRow[] };

// Dispatch by the table's SQL name (via drizzle getTableName) rather than object
// identity — the route is dynamically imported after vi.resetModules, so its
// @hale/db schema objects are a different instance than this file's would be.
function fakeDb(): Database {
  const db = {
    select: () => ({
      from: (table: object) => {
        const name = getTableName(table as Parameters<typeof getTableName>[0]);
        if (name === 'children') return { where: async () => dbRows.children };
        if (name === 'family_memory_episodes') {
          return { where: () => ({ orderBy: () => ({ limit: async () => dbRows.episodes }) }) };
        }
        throw new Error(`unexpected select target: ${name}`);
      },
    }),
  };
  return db as unknown as Database;
}

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => fakeDb() }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: () => currentFamilyIdMock(),
  resolveUserIdForUser: vi.fn(async () => 'user-1'),
}));

function session(id: string | null) {
  return id ? { user: { id } } : null;
}

async function callGet(query = ''): Promise<Response> {
  const { GET } = await import('~/app/api/mobile/companion/logs/route');
  return GET(new Request(`http://localhost/api/mobile/companion/logs${query}`));
}

const TEEN_ID = 'teen-1';
const TODDLER_ID = 'tot-1';

beforeEach(() => {
  vi.resetModules();
  authMock.mockReset();
  currentFamilyIdMock.mockReset();
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  dbRows = { children: [], episodes: [] };
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/mobile/companion/logs — auth + family gating', () => {
  it('returns 401 when signed out', async () => {
    authMock.mockResolvedValue(session(null));

    const res = await callGet();

    expect(res.status).toBe(401);
  });

  it('returns 403 when signed in but no family resolves', async () => {
    authMock.mockResolvedValue(session('ext-1'));
    currentFamilyIdMock.mockResolvedValue(null);

    const res = await callGet();

    expect(res.status).toBe(403);
  });
});

describe('GET /api/mobile/companion/logs — shared read (redaction + numerics)', () => {
  beforeEach(() => {
    authMock.mockResolvedValue(session('ext-1'));
    currentFamilyIdMock.mockResolvedValue('fam-1');
  });

  it("drops a 13+ child's own rows and lifts numerics on the survivors", async () => {
    dbRows = {
      children: [
        { id: TEEN_ID, dateOfBirth: '2011-01-01' }, // ~14y → teenager
        { id: TODDLER_ID, dateOfBirth: '2024-05-01' },
      ],
      episodes: [
        {
          id: 'teen-e',
          childId: TEEN_ID,
          authoredBy: null, // pipeline-authored teen content
          episodeType: 'nap',
          summary: 'Napped 55 min',
          occurredAt: new Date('2026-07-05T14:00:00Z'),
          payload: { durationMin: 55 },
        },
        {
          id: 'tot-e',
          childId: TODDLER_ID,
          authoredBy: 'user-1',
          episodeType: 'feed',
          summary: 'Fed 120 ml (bottle)',
          occurredAt: new Date('2026-07-05T11:00:00Z'),
          payload: { amountMl: 120, feedKind: 'bottle', note: 'spit up a little' },
        },
      ],
    };

    const res = await callGet();

    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.logs.map((l: { id: string }) => l.id);
    expect(ids).toContain('tot-e');
    expect(ids).not.toContain('teen-e');
    // The teen row and its number never reach the wire.
    expect(JSON.stringify(body)).not.toContain('55');
    // Numerics lifted; raw note never lifted (rule #1).
    const feed = body.logs.find((l: { id: string }) => l.id === 'tot-e');
    expect(feed).toMatchObject({ amountMl: 120, feedKind: 'bottle' });
    expect(JSON.stringify(body)).not.toContain('spit up');
  });

  it('accepts episodeType=measurement (the one narrowing Growth uses)', async () => {
    dbRows = { children: [{ id: TODDLER_ID, dateOfBirth: '2024-05-01' }], episodes: [] };
    const res = await callGet('?episodeType=measurement');
    expect(res.status).toBe(200);
  });

  it('rejects any other episodeType with 400 — the param is not a general filter', async () => {
    dbRows = { children: [{ id: TODDLER_ID, dateOfBirth: '2024-05-01' }], episodes: [] };
    const res = await callGet('?episodeType=nap');
    expect(res.status).toBe(400);
    const bogus = await callGet('?episodeType=anything');
    expect(bogus.status).toBe(400);
  });
});
