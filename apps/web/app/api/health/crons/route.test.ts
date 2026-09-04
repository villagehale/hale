import { schema } from '@hale/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cronSlug } from '~/lib/cron/deadman';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import vercelConfig from '~/vercel.json';

/**
 * GET /api/health/crons — the dead-man switch's public face, tested through the
 * REAL handler. This body is the one fact the off-Vercel checker
 * (.github/workflows/cron-deadman.yml) trusts, so the test must invoke the
 * route, not re-serialize assessCronHealth: a route that hardcoded `ok: true`
 * would leave every deadman.ts unit test green while silencing the alarm the
 * switch exists to sound. The stale case below derives `ok` from seeded ledger
 * state, so exactly that mutation turns it red.
 *
 * Real seams throughout: real route → real ~/lib/db → createDb (the single
 * chokepoint, redirected per test) → real Drizzle over PGlite with every
 * committed migration applied — the cron_heartbeats table is byte-for-byte the
 * production one.
 */

const createDbMock = vi.fn();

vi.mock('@hale/db', async (importActual) => {
  const actual = await importActual<typeof import('@hale/db')>();
  return {
    ...actual,
    createDb: (...args: unknown[]) => createDbMock(...args),
  };
});

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

/** Every cron the manifest of record declares — the same file the route imports. */
const ALL_SLUGS = vercelConfig.crons.map((cron) => cronSlug(cron.path));

/**
 * Older than every threshold the manifest can produce: the longest cadence is
 * weekly, whose stale limit is 2 × 7 days + 15 min grace ≈ 14.26 days.
 */
const OLDER_THAN_EVERY_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

async function seedLedger(rows: { name: string; lastRanAt: Date }[]): Promise<void> {
  await db.database.delete(schema.cronHeartbeats);
  if (rows.length > 0) await db.database.insert(schema.cronHeartbeats).values(rows);
}

async function callRoute(): Promise<Response> {
  const { GET } = await import('./route');
  return GET();
}

describe('GET /api/health/crons', () => {
  beforeEach(() => {
    vi.resetModules();
    createDbMock.mockReset();
    createDbMock.mockImplementation(() => db.database);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers ok:false naming exactly the stale crons, still status 200', async () => {
    const staleNames = ['drain', 'reminders'];
    const staleAt = new Date(Date.now() - OLDER_THAN_EVERY_THRESHOLD_MS);
    const freshAt = new Date();
    await seedLedger(
      ALL_SLUGS.map((name) => ({
        name,
        lastRanAt: staleNames.includes(name) ? staleAt : freshAt,
      })),
    );

    const response = await callRoute();

    // 200, not 5xx: "a cron is stale" is a successful health answer — the
    // checker reads the body's verdict; only an unreachable ledger is a 5xx.
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(false);
    const reportedStale = body.crons
      .filter((cron: { status: string }) => cron.status === 'stale')
      .map((cron: { name: string }) => cron.name)
      .sort();
    expect(reportedStale).toEqual([...staleNames].sort());
    expect(body.crons.filter((cron: { status: string }) => cron.status === 'ok')).toHaveLength(
      ALL_SLUGS.length - staleNames.length,
    );
  });

  it('answers ok:true when every declared cron has a fresh stamp', async () => {
    const freshAt = new Date();
    await seedLedger(ALL_SLUGS.map((name) => ({ name, lastRanAt: freshAt })));

    const response = await callRoute();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.crons).toHaveLength(vercelConfig.crons.length);
    expect(body.crons.every((cron: { status: string }) => cron.status === 'ok')).toBe(true);
  });

  it('answers 503 db_unreachable when the connection factory itself fails', async () => {
    createDbMock.mockImplementation(() => {
      throw new Error('connection refused (poisoned createDb)');
    });

    const response = await callRoute();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'db_unreachable' });
    // The poison FIRED — db() reached the chokepoint (DATABASE_URL is set by
    // vitest.setup.ts), so this 503 is the factory failure, not a missing env.
    expect(createDbMock).toHaveBeenCalled();
  });
});
