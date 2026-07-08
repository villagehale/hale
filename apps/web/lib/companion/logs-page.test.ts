import { type Database, schema } from '@hale/db';
import { describe, expect, it, vi } from 'vitest';

// logs-page.ts's request wrapper (loadLogsPage) imports the server-only auth chain;
// mock it (as recent-logs.test.ts does) so the pure readLogsPage is importable here.
vi.mock('~/lib/db', () => ({ db: vi.fn() }));
vi.mock('~/lib/family', () => ({ currentFamilyId: vi.fn(), currentUserId: vi.fn() }));

const { readLogsPage } = await import('./logs-page.js');

/**
 * readLogsPage is the shared, family-scoped, teen-redacted read behind BOTH the web
 * logs view and the mobile logs route. This suite pins three contracts on the REAL
 * function (a fake db serves rows; no infra touched):
 *
 *  1. Pagination shape — a full page yields a nextCursor (the last row's
 *     occurredAt); a short page yields null. The cursor advances on the RAW fetch so
 *     a fully-redacted page never stalls.
 *  2. Teen redaction (rule #1) — a 13+ child's own (non-parent-authored) rows are
 *     DROPPED. The test FAILS if the redaction is removed — the guard that a numeric
 *     widening never becomes a teen leak.
 *  3. Numerics present — durationMin / amountMl / feedKind are lifted from payload
 *     onto surviving rows (numbers only, never the raw payload / note).
 */

const FAMILY_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = 'parent-1';
const TEEN_ID = 'teen-1';
const TODDLER_ID = 'tot-1';

interface EpisodeRow {
  id: string;
  childId: string | null;
  authoredBy: string | null;
  episodeType: string;
  summary: string;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

function fakeDb(
  children: Array<{ id: string; dateOfBirth: string }>,
  episodes: EpisodeRow[],
): Database {
  const db = {
    select: () => ({
      from: (table: unknown) => {
        if (table === schema.children) {
          // children read: select → from → where (awaited)
          return { where: async () => children };
        }
        if (table === schema.familyMemoryEpisodes) {
          // episode read: select → from → where → orderBy → limit
          return {
            where: () => ({
              orderBy: () => ({
                limit: async () => episodes,
              }),
            }),
          };
        }
        throw new Error('unexpected select target');
      },
    }),
  };
  return db as unknown as Database;
}

function napRow(id: string, childId: string, durationMin: number, occurredAt: string): EpisodeRow {
  return {
    id,
    childId,
    authoredBy: PARENT_ID,
    episodeType: 'nap',
    summary: `Napped ${durationMin} min`,
    occurredAt: new Date(occurredAt),
    payload: { durationMin },
  };
}

describe('readLogsPage — pagination shape', () => {
  it('returns the last row occurredAt as nextCursor when a full page came back', async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      napRow(`r${i}`, TODDLER_ID, 30 + i, `2026-07-0${3 + i}T10:00:00Z`),
    );
    const db = fakeDb([{ id: TODDLER_ID, dateOfBirth: '2024-05-01' }], rows);

    const page = await readLogsPage(db, FAMILY_ID, PARENT_ID, { limit: 3 });

    expect(page.logs).toHaveLength(3);
    expect(page.nextCursor).toBe(rows[rows.length - 1]?.occurredAt.toISOString());
  });

  it('returns a null cursor on a short page (the last page)', async () => {
    const rows = [napRow('r0', TODDLER_ID, 45, '2026-07-05T10:00:00Z')];
    const db = fakeDb([{ id: TODDLER_ID, dateOfBirth: '2024-05-01' }], rows);

    const page = await readLogsPage(db, FAMILY_ID, PARENT_ID, { limit: 3 });

    expect(page.nextCursor).toBeNull();
  });
});

describe('readLogsPage — teen redaction (rule #1)', () => {
  it("drops a 13+ child's own (non-parent-authored) rows and keeps the toddler's", async () => {
    const teenOwn: EpisodeRow = {
      id: 'teen-e',
      childId: TEEN_ID,
      authoredBy: null, // pipeline-authored teen content, not the parent's own log
      episodeType: 'nap',
      summary: 'Napped 55 min',
      occurredAt: new Date('2026-07-05T14:00:00Z'),
      payload: { durationMin: 55 },
    };
    const toddler = napRow('tot-e', TODDLER_ID, 40, '2026-07-05T10:00:00Z');
    const db = fakeDb(
      [
        { id: TEEN_ID, dateOfBirth: '2011-01-01' }, // ~14y → teenager
        { id: TODDLER_ID, dateOfBirth: '2024-05-01' },
      ],
      [teenOwn, toddler],
    );

    const page = await readLogsPage(db, FAMILY_ID, PARENT_ID, { limit: 30 });

    const ids = page.logs.map((l) => l.id);
    expect(ids).toContain('tot-e');
    expect(ids).not.toContain('teen-e');
    // No teen number leaks through the widening either.
    expect(JSON.stringify(page.logs)).not.toContain('55');
  });
});

describe('readLogsPage — numerics lifted from payload', () => {
  it('lifts durationMin / amountMl / feedKind but never the raw note', async () => {
    const feed: EpisodeRow = {
      id: 'feed-e',
      childId: TODDLER_ID,
      authoredBy: PARENT_ID,
      episodeType: 'feed',
      summary: 'Fed 120 ml (bottle)',
      occurredAt: new Date('2026-07-05T11:00:00Z'),
      payload: { amountMl: 120, feedKind: 'bottle', note: 'spit up a little' },
    };
    const nap = napRow('nap-e', TODDLER_ID, 90, '2026-07-05T09:00:00Z');
    const db = fakeDb([{ id: TODDLER_ID, dateOfBirth: '2024-05-01' }], [feed, nap]);

    const page = await readLogsPage(db, FAMILY_ID, PARENT_ID, { limit: 30 });

    const feedView = page.logs.find((l) => l.id === 'feed-e');
    expect(feedView).toMatchObject({ amountMl: 120, feedKind: 'bottle' });
    // The raw note is payload content, never lifted (rule #1).
    expect(feedView).not.toHaveProperty('note');
    expect(JSON.stringify(page.logs)).not.toContain('spit up');

    const napView = page.logs.find((l) => l.id === 'nap-e');
    expect(napView).toMatchObject({ durationMin: 90 });
    expect(napView).not.toHaveProperty('amountMl');
  });

  it('drops a free-text feedKind — episodes have a second (worker) writer, and only the enum surfaces', async () => {
    const feed: EpisodeRow = {
      id: 'feed-x',
      childId: TODDLER_ID,
      authoredBy: PARENT_ID,
      episodeType: 'feed',
      summary: 'Fed',
      occurredAt: new Date('2026-07-05T11:00:00Z'),
      payload: { amountMl: 90, feedKind: 'pipeline says: mystery formula brand' },
    };
    const db = fakeDb([{ id: TODDLER_ID, dateOfBirth: '2024-05-01' }], [feed]);

    const page = await readLogsPage(db, FAMILY_ID, PARENT_ID, { limit: 30 });

    const view = page.logs.find((l) => l.id === 'feed-x');
    expect(view).toMatchObject({ amountMl: 90 });
    expect(view).not.toHaveProperty('feedKind');
    expect(JSON.stringify(page.logs)).not.toContain('mystery formula');
  });

  it('lifts an enum-gated measurement (measureKind + value + unit) as a set', async () => {
    const measurement: EpisodeRow = {
      id: 'm-e',
      childId: TODDLER_ID,
      authoredBy: PARENT_ID,
      episodeType: 'measurement',
      summary: 'Weighed 10.4 kg',
      occurredAt: new Date('2026-07-05T08:00:00Z'),
      payload: { measureKind: 'weight', value: 10.4, unit: 'kg', note: 'after breakfast' },
    };
    const db = fakeDb([{ id: TODDLER_ID, dateOfBirth: '2024-05-01' }], [measurement]);

    const page = await readLogsPage(db, FAMILY_ID, PARENT_ID, { limit: 30 });

    const view = page.logs.find((l) => l.id === 'm-e');
    expect(view).toMatchObject({ measureKind: 'weight', value: 10.4, unit: 'kg' });
    // The raw note is payload content, never lifted (rule #1).
    expect(view).not.toHaveProperty('note');
    expect(JSON.stringify(page.logs)).not.toContain('after breakfast');
  });

  it('drops a free-text measureKind — same second-writer enum gate as feedKind', async () => {
    const measurement: EpisodeRow = {
      id: 'm-x',
      childId: TODDLER_ID,
      authoredBy: PARENT_ID,
      episodeType: 'measurement',
      summary: 'measured',
      occurredAt: new Date('2026-07-05T08:00:00Z'),
      payload: { measureKind: 'pipeline says: temperature', value: 37, unit: 'C' },
    };
    const db = fakeDb([{ id: TODDLER_ID, dateOfBirth: '2024-05-01' }], [measurement]);

    const page = await readLogsPage(db, FAMILY_ID, PARENT_ID, { limit: 30 });

    const view = page.logs.find((l) => l.id === 'm-x');
    expect(view).not.toHaveProperty('measureKind');
    expect(view).not.toHaveProperty('value');
    expect(JSON.stringify(page.logs)).not.toContain('temperature');
  });

  it("never leaks a 13+ child's own measurement number through the widening", async () => {
    const teenMeasurement: EpisodeRow = {
      id: 'teen-m',
      childId: TEEN_ID,
      authoredBy: null, // pipeline-authored teen content
      episodeType: 'measurement',
      summary: 'Weighed 61 kg',
      occurredAt: new Date('2026-07-05T08:00:00Z'),
      payload: { measureKind: 'weight', value: 61, unit: 'kg' },
    };
    const db = fakeDb(
      [
        { id: TEEN_ID, dateOfBirth: '2011-01-01' },
        { id: TODDLER_ID, dateOfBirth: '2024-05-01' },
      ],
      [teenMeasurement],
    );

    const page = await readLogsPage(db, FAMILY_ID, PARENT_ID, { limit: 30 });

    expect(page.logs.map((l) => l.id)).not.toContain('teen-m');
    expect(JSON.stringify(page.logs)).not.toContain('61');
  });
});
