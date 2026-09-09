import { schema } from '@hale/db';
import PgBoss from 'pg-boss';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNEL_MESSAGE_RECEIVED_QUEUE } from '~/lib/channel/config';
import { cronSlug, INBOUND_LANE_NAME } from '~/lib/cron/deadman';
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
let boss: PgBoss;

/**
 * The REAL pg-boss, booted over the test PGlite through its own external-db
 * hook — its schema-v24 DDL, its `job_state` enum, its LIST partition, its
 * send/fetch/fail state machine. A hand-copied `CREATE TABLE pgboss.job` would
 * be a cheaper copy of the very thing under test (the lane reads pg-boss's
 * table, so the table's real shape IS the contract). `exec` runs the
 * parameterless multi-statement DDL scripts over the simple protocol; `query`
 * carries everything with bind parameters.
 */
async function bootPgBoss(): Promise<PgBoss> {
  const started = new PgBoss({
    schema: 'pgboss',
    supervise: false,
    schedule: false,
    db: {
      async executeSql(text: string, values?: unknown[]) {
        if (values && values.length > 0) return await db.client.query(text, values);
        const results = await db.client.exec(text);
        return results.at(-1) ?? { rows: [] };
      },
    },
  } as never);
  await started.start();
  await started.createQueue(CHANNEL_MESSAGE_RECEIVED_QUEUE);
  return started;
}

beforeAll(async () => {
  db = await createTestDb();
  boss = await bootPgBoss();
}, 120_000);

afterAll(async () => {
  await boss.stop({ wait: false });
  await db.close();
});

/** Empties the lane between cases — the parent table cascades to its partitions. */
async function clearInboundLane(): Promise<void> {
  await db.exec('delete from pgboss.job');
}

/** One inbound turn, taken through pg-boss's own send → fetch → fail arc. */
async function failOneInboundTurn(): Promise<void> {
  await boss.send(CHANNEL_MESSAGE_RECEIVED_QUEUE, {});
  // `ignoreStartAfter` drops pg-boss's `start_after < now()` clause: a job sent
  // and fetched in the same millisecond is otherwise not yet due, and this test
  // is about the job's FATE, not the scheduler's clock.
  const [job] = await boss.fetch(CHANNEL_MESSAGE_RECEIVED_QUEUE, { ignoreStartAfter: true });
  if (!job) throw new Error('pg-boss returned no job to fail');
  await boss.fail(CHANNEL_MESSAGE_RECEIVED_QUEUE, job.id, { message: 'handler threw' });
}

function laneOf(body: { crons: { name: string }[] }): Record<string, unknown> | undefined {
  return body.crons.find((cron) => cron.name === INBOUND_LANE_NAME) as
    | Record<string, unknown>
    | undefined;
}

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
    // +1 for the inbound lane, which is healthy here and rides the same array.
    expect(body.crons.filter((cron: { status: string }) => cron.status === 'ok')).toHaveLength(
      ALL_SLUGS.length - staleNames.length + 1,
    );
  });

  it('answers ok:true when every declared cron has a fresh stamp', async () => {
    const freshAt = new Date();
    await seedLedger(ALL_SLUGS.map((name) => ({ name, lastRanAt: freshAt })));

    const response = await callRoute();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.crons).toHaveLength(vercelConfig.crons.length + 1);
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

/**
 * THE INBOUND LANE, over the real queue (#617/#622 replayed).
 *
 * The night this exists for: every cron stamped on time and the endpoint said
 * "ok" for six hours while a parent's text sat in pg-boss `retry`. These cases
 * run the REAL route against the REAL pg-boss table, so the discriminating
 * pair — every cron ok, the lane stale — is proven by the database rather than
 * restated.
 *
 * Ordered: the refusal case drops the schema and must go last.
 */
describe('GET /api/health/crons · the inbound turn lane', () => {
  beforeEach(async () => {
    vi.resetModules();
    createDbMock.mockReset();
    createDbMock.mockImplementation(() => db.database);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await seedLedger(ALL_SLUGS.map((name) => ({ name, lastRanAt: new Date() })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a turn the handler threw on reads stale while every cron reads ok', async () => {
    await clearInboundLane();
    await failOneInboundTurn();
    await db.exec(`update pgboss.job set created_on = now() - interval '30 minutes'`);

    // THE TRUE POST-FAILURE SHAPE: boss.fail leaves state 'retry' with
    // retry_count STILL 0 (pg-boss increments at the next fetch), so a lane
    // predicate written on retry_count > 0 would see nothing here.
    const { rows } = await db.client.query<{ state: string; retry_count: number }>(
      'select state::text as state, retry_count from pgboss.job',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.state).toBe('retry');
    expect(rows[0]?.retry_count).toBe(0);

    const body = await (await callRoute()).json();

    expect(body.ok).toBe(false);
    // Load-bearing: ok:false came from the lane ALONE.
    const crons: { name: string; status: string }[] = body.crons;
    expect(crons.filter((cron) => cron.status !== 'ok').map((cron) => cron.name)).toEqual([
      INBOUND_LANE_NAME,
    ]);
    const lane = laneOf(body);
    expect(lane?.status).toBe('stale');
    expect(lane?.staleAfterSeconds).toBe(600);
    expect(lane?.ageSeconds as number).toBeGreaterThanOrEqual(1_790);
    expect(lane?.ageSeconds as number).toBeLessThan(1_900);
  });

  it('the same job, completed, leaves the lane empty — and the age stays withheld', async () => {
    await clearInboundLane();
    await boss.send(CHANNEL_MESSAGE_RECEIVED_QUEUE, {});
    const [job] = await boss.fetch(CHANNEL_MESSAGE_RECEIVED_QUEUE, { ignoreStartAfter: true });
    if (!job) throw new Error('pg-boss returned no job to complete');
    await boss.complete(CHANNEL_MESSAGE_RECEIVED_QUEUE, job.id);
    await db.exec(`update pgboss.job set created_on = now() - interval '30 minutes'`);

    const response = await callRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.crons).toHaveLength(vercelConfig.crons.length + 1);
    expect(laneOf(body)).toEqual({
      name: INBOUND_LANE_NAME,
      status: 'ok',
      ageSeconds: null,
      staleAfterSeconds: 600,
    });
  });

  it('a lane it cannot read answers 503 inbound_lane_unreadable, never a hollow ok', async () => {
    // The heartbeat ledger is still perfectly readable — this is NOT db_unreachable,
    // and folding it into that bucket would lose the one detail an operator needs.
    await db.exec('drop schema pgboss cascade');

    const response = await callRoute();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'inbound_lane_unreadable' });
    expect(await db.database.select().from(schema.cronHeartbeats)).not.toHaveLength(0);
  });
});
