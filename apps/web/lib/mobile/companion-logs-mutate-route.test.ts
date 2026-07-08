import { type Database, schema } from '@hale/db';
import type { SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * PATCH + DELETE /api/mobile/companion/logs — the native Diary edit + soft-delete.
 * Both wrap the EXACT audited lib the web editQuickEpisode / deleteQuickEpisode
 * actions call (updateEpisode / softDeleteEpisode). The kept-REAL lib runs over a
 * fake transaction db so the three contracts hold against the real code, not a stub:
 *
 *  1. Family scoping (rule #1) — the lib's WHERE (id AND family_id) is the guard.
 *     A foreign episode matches NO row → the lib returns false → the route answers
 *     403, and NO audit row is written. The fake EVALUATES the real WHERE (it reads
 *     the eq-constraints off the SQL the lib builds) against a seeded row whose
 *     family_id differs from the request's — so if the lib ever dropped eq(family_id),
 *     the id-only WHERE would MATCH the foreign row and this test would fail closed.
 *  2. Audit (rule #6) — a matched edit/delete writes ONE immutable audit_log row
 *     (actionTaken quick_log_edited / quick_log_deleted) in the same transaction.
 *  3. Gating — signed-out → 401, no family → 403, malformed body → 400, each before
 *     any write.
 *
 * A teen's row is unreachable BY CONSTRUCTION: edit/delete key off the episode id
 * within the family scope, and a parent never obtains a teen episode's id — the read
 * path (readLogsPage) drops teen rows before they reach any client (rule #1), so no
 * id to edit/delete is ever surfaced. (Proven in companion-logs-route.test.ts.)
 */

const authMock = vi.fn();
const currentFamilyIdMock = vi.fn();
const resolveUserIdMock = vi.fn();

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_FAMILY_ID = '99999999-9999-4999-8999-999999999999';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const EPISODE_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-07-07T12:00:00.000Z');

const BEFORE_ROW = {
  occurredAt: new Date('2026-07-06T08:00:00Z'),
  summary: 'Fed 120 ml',
  payload: { amountMl: 120 },
};

interface SeededRow {
  id: string;
  familyId: string;
  occurredAt: Date;
  summary: string;
  payload: Record<string, unknown>;
}

interface Capture {
  updateValues: Record<string, unknown>[];
  audit: Record<string, unknown>[];
}

// The rows the fake tx db serves. The scoping test seeds a row whose family_id is
// NOT the request's family, so ONLY the real family-scoped WHERE (id AND family_id)
// misses it. A bare-id WHERE (the regression) would match it and let the edit through.
let seeded: SeededRow[];
let capture: Capture;

/**
 * Reads the equality constraints ({ id, family_id, ... }) off a Drizzle WHERE by
 * walking its SQL chunks: a column chunk (has a `.name` + `.table`) followed by the
 * bound Param carries one `col = value`. This is what makes the fake EVALUATE the
 * lib's real WHERE instead of stipulating a match — drop eq(family_id) and this
 * extractor stops seeing the family constraint, so a foreign row matches.
 */
function eqConstraints(sql: SQL, out: Record<string, unknown> = {}): Record<string, unknown> {
  const chunks = (sql as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  let lastCol: string | null = null;
  for (const chunk of chunks) {
    const c = chunk as { constructor?: { name?: string }; name?: string; table?: unknown; value?: unknown };
    if (c?.constructor?.name === 'SQL') {
      eqConstraints(chunk as SQL, out);
      lastCol = null;
      continue;
    }
    if (typeof c?.name === 'string' && c.table) {
      lastCol = c.name;
      continue;
    }
    if (c?.constructor?.name === 'Param' && lastCol) {
      out[lastCol] = c.value;
      lastCol = null;
    }
  }
  return out;
}

/** The seeded rows whose id + family_id satisfy the WHERE the lib built. */
function matchingRows(where: SQL): SeededRow[] {
  const c = eqConstraints(where);
  return seeded.filter(
    (row) =>
      (c.id === undefined || row.id === c.id) &&
      (c.family_id === undefined || row.familyId === c.family_id),
  );
}

function fakeDb(): Database {
  const tx = {
    select: () => ({
      from: () => ({
        where: (where: SQL) => ({
          limit: async () => matchingRows(where).map(({ id: _id, familyId: _f, ...snap }) => snap),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: (where: SQL) => ({
          returning: async () => {
            const rows = matchingRows(where);
            if (rows.length > 0) capture.updateValues.push(patch);
            return rows.map((r) => ({ id: r.id }));
          },
        }),
      }),
    }),
    insert: (table: unknown) => {
      if (table !== schema.auditLog) throw new Error('unexpected insert target');
      return {
        values: async (row: Record<string, unknown>) => {
          capture.audit.push(row);
        },
      };
    },
  };
  return {
    transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
  } as unknown as Database;
}

vi.mock('~/auth', () => ({ auth: () => authMock() }));
vi.mock('~/lib/db', () => ({ db: () => fakeDb() }));
vi.mock('~/lib/family', () => ({
  currentFamilyId: () => currentFamilyIdMock(),
  resolveUserIdForUser: (...a: unknown[]) => resolveUserIdMock(...a),
}));

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: () => {
      throw new Error('mobile logs mutate route must NOT construct its own db (rule #1)');
    },
  };
});

async function callPatch(body: unknown): Promise<Response> {
  const { PATCH } = await import('~/app/api/mobile/companion/logs/route');
  return PATCH(
    new Request('http://localhost/api/mobile/companion/logs', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

async function callDelete(body: unknown): Promise<Response> {
  const { DELETE } = await import('~/app/api/mobile/companion/logs/route');
  return DELETE(
    new Request('http://localhost/api/mobile/companion/logs', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  authMock.mockReset();
  currentFamilyIdMock.mockReset();
  resolveUserIdMock.mockReset();
  vi.stubEnv('DATABASE_URL', 'postgres://test');
  authMock.mockResolvedValue({ user: { id: 'ext-1' } });
  currentFamilyIdMock.mockResolvedValue(FAMILY_ID);
  resolveUserIdMock.mockResolvedValue(ACTOR_ID);
  capture = { updateValues: [], audit: [] };
  seeded = [{ id: EPISODE_ID, familyId: FAMILY_ID, ...BEFORE_ROW }];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('PATCH /api/mobile/companion/logs — edit gating', () => {
  it('returns 401 for a signed-out caller and never writes', async () => {
    authMock.mockResolvedValue(null);

    const res = await callPatch({ id: EPISODE_ID, summary: 'Fed 150 ml' });

    expect(res.status).toBe(401);
    expect(capture.audit).toEqual([]);
  });

  it('returns 403 when signed in but no family resolves', async () => {
    currentFamilyIdMock.mockResolvedValue(null);

    const res = await callPatch({ id: EPISODE_ID, summary: 'Fed 150 ml' });

    expect(res.status).toBe(403);
    expect(capture.audit).toEqual([]);
  });

  it('returns 400 for a malformed body (missing summary) and never writes', async () => {
    const res = await callPatch({ id: EPISODE_ID });

    expect(res.status).toBe(400);
    expect(capture.audit).toEqual([]);
  });
});

describe('PATCH /api/mobile/companion/logs — family-scoped edit (rules #1, #6)', () => {
  it('edits a matched episode and writes ONE audit_log row (quick_log_edited)', async () => {
    const res = await callPatch({
      id: EPISODE_ID,
      summary: 'Fed 150 ml',
      occurredAt: '2026-07-07T09:00:00.000Z',
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'edited' });
    expect(capture.updateValues).toHaveLength(1);
    expect(capture.updateValues[0]).toMatchObject({
      summary: 'Fed 150 ml',
      occurredAt: new Date('2026-07-07T09:00:00.000Z'),
    });
    expect(capture.audit).toHaveLength(1);
    expect(capture.audit[0]).toMatchObject({
      familyId: FAMILY_ID,
      actor: ACTOR_ID,
      actionTaken: 'quick_log_edited',
      targetTable: 'family_memory_episodes',
      targetId: EPISODE_ID,
    });
  });

  it("rejects another family's episode id with 403 — no update, no audit row", async () => {
    // The episode with this id belongs to ANOTHER family. Only the real WHERE
    // (id AND family_id) misses it; a bare-id WHERE would match and let the edit
    // through — so this asserts the family scope is actually evaluated.
    seeded = [{ id: EPISODE_ID, familyId: OTHER_FAMILY_ID, ...BEFORE_ROW }];

    const res = await callPatch({ id: EPISODE_ID, summary: 'hijacked' });

    expect(res.status).toBe(403);
    expect(capture.updateValues).toEqual([]);
    expect(capture.audit).toEqual([]);
  });
});

describe('DELETE /api/mobile/companion/logs — family-scoped soft-delete (rules #1, #6, #9)', () => {
  it('soft-deletes a matched episode (stamps deletedAt) and writes ONE audit row', async () => {
    const res = await callDelete({ id: EPISODE_ID });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'deleted' });
    // Soft, not hard: SET deleted_at rather than a DELETE.
    expect(capture.updateValues).toHaveLength(1);
    expect(capture.updateValues[0]?.deletedAt).toEqual(NOW);
    expect(capture.audit).toHaveLength(1);
    expect(capture.audit[0]).toMatchObject({
      actor: ACTOR_ID,
      actionTaken: 'quick_log_deleted',
      targetId: EPISODE_ID,
      after: { deleted: true },
    });
  });

  it("rejects another family's episode id with 403 — no delete, no audit row", async () => {
    seeded = [{ id: EPISODE_ID, familyId: OTHER_FAMILY_ID, ...BEFORE_ROW }];

    const res = await callDelete({ id: EPISODE_ID });

    expect(res.status).toBe(403);
    expect(capture.updateValues).toEqual([]);
    expect(capture.audit).toEqual([]);
  });

  it('returns 401 for a signed-out caller and never writes', async () => {
    authMock.mockResolvedValue(null);

    const res = await callDelete({ id: EPISODE_ID });

    expect(res.status).toBe(401);
    expect(capture.audit).toEqual([]);
  });
});
