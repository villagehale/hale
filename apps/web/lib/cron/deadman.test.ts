import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schema } from '@hale/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from '~/lib/testing/pglite';
import {
  assessCronHealth,
  type CronManifestEntry,
  cronSlug,
  STALE_GRACE_SECONDS,
  schedulePeriodSeconds,
  staleAfterSeconds,
} from './deadman';
import { armCronHeartbeats, stampCronHeartbeat } from './heartbeat';

/**
 * The dead-man switch end to end (audit P1-8): schedules classify into
 * periods, stamps land in the real cron_heartbeats table (real DDL via
 * pglite), a frozen stamp turns the report stale, and the ACTUAL off-Vercel
 * checker script — the same file GitHub Actions runs — alarms on that report.
 * The checker is exercised by spawning it, not by reimplementing its parse.
 */

const WEB_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHECKER = fileURLToPath(
  new URL('../../../../.github/scripts/cron-deadman-check.mjs', import.meta.url),
);

function manifest(): CronManifestEntry[] {
  return (
    JSON.parse(readFileSync(`${WEB_ROOT}vercel.json`, 'utf8')) as { crons: CronManifestEntry[] }
  ).crons;
}

/** Runs the real checker in --stdin mode; returns its exit code and output. */
function runChecker(httpStatus: number, body: string): { exitCode: number; output: string } {
  try {
    const output = execFileSync(
      process.execPath,
      [CHECKER, '--stdin', String(httpStatus)],
      { input: body, encoding: 'utf8' },
    );
    return { exitCode: 0, output };
  } catch (err) {
    const failure = err as { status: number | null; stdout: string };
    return { exitCode: failure.status ?? -1, output: failure.stdout };
  }
}

describe('cronSlug', () => {
  it('takes the path segment the route stamps under', () => {
    expect(cronSlug('/api/cron/drain')).toBe('drain');
    expect(cronSlug('/api/cron/week-plan')).toBe('week-plan');
  });

  it('refuses a non-cron path', () => {
    expect(() => cronSlug('/api/health')).toThrow('not a cron path');
  });
});

describe('schedulePeriodSeconds', () => {
  it('classifies every shape vercel.json uses', () => {
    expect(schedulePeriodSeconds('* * * * *')).toBe(60); // drain
    expect(schedulePeriodSeconds('*/5 * * * *')).toBe(300); // registration-sequence
    expect(schedulePeriodSeconds('*/10 * * * *')).toBe(600); // queue-maintenance
    expect(schedulePeriodSeconds('4-59/10 * * * *')).toBe(600); // twilio-triage
    expect(schedulePeriodSeconds('*/15 * * * *')).toBe(900); // connector-sync
    expect(schedulePeriodSeconds('2 * * * *')).toBe(3_600); // week-plan (hourly)
    expect(schedulePeriodSeconds('42 6 * * *')).toBe(86_400); // inference (daily)
    expect(schedulePeriodSeconds('47 13 * * 1')).toBe(604_800); // discovery (weekly)
  });

  it('throws on shapes it has never classified, rather than guessing', () => {
    expect(() => schedulePeriodSeconds('0 0 1 * *')).toThrow('unrecognized');
    expect(() => schedulePeriodSeconds('whenever')).toThrow('unrecognized');
    expect(() => schedulePeriodSeconds('a * * * *')).toThrow('unrecognized');
  });

  it('classifies every schedule in the REAL manifest — a new cadence must be added here first', () => {
    for (const { schedule } of manifest()) {
      expect(() => schedulePeriodSeconds(schedule), schedule).not.toThrow();
    }
  });

  it('staleness threshold is two missed fires plus grace', () => {
    expect(staleAfterSeconds('* * * * *')).toBe(2 * 60 + STALE_GRACE_SECONDS);
    expect(staleAfterSeconds('47 13 * * 1')).toBe(2 * 604_800 + STALE_GRACE_SECONDS);
  });
});

describe('assessCronHealth', () => {
  const entries: CronManifestEntry[] = [
    { path: '/api/cron/drain', schedule: '* * * * *' },
    { path: '/api/cron/week-plan', schedule: '2 * * * *' },
  ];
  const now = new Date('2026-09-03T12:00:00Z');

  it('fresh stamps are ok', () => {
    const report = assessCronHealth(
      entries,
      [
        { name: 'drain', lastRanAt: new Date('2026-09-03T11:59:00Z') },
        { name: 'week-plan', lastRanAt: new Date('2026-09-03T11:02:00Z') },
      ],
      now,
    );
    expect(report.ok).toBe(true);
    expect(report.crons.map((cron) => cron.status)).toEqual(['ok', 'ok']);
  });

  it('a stamp older than its threshold is stale and flips ok', () => {
    const report = assessCronHealth(
      entries,
      [
        { name: 'drain', lastRanAt: new Date('2026-09-03T09:00:00Z') }, // 3h > 17min limit
        { name: 'week-plan', lastRanAt: new Date('2026-09-03T11:02:00Z') },
      ],
      now,
    );
    expect(report.ok).toBe(false);
    expect(report.crons.find((cron) => cron.name === 'drain')).toMatchObject({
      status: 'stale',
      ageSeconds: 3 * 3_600,
      staleAfterSeconds: 2 * 60 + STALE_GRACE_SECONDS,
    });
    expect(report.crons.find((cron) => cron.name === 'week-plan')?.status).toBe('ok');
  });

  it('a cron the ledger has never seen is armed, not a false page', () => {
    const report = assessCronHealth(
      entries,
      [{ name: 'drain', lastRanAt: new Date('2026-09-03T11:59:00Z') }],
      now,
    );
    expect(report.ok).toBe(true);
    expect(report.crons.find((cron) => cron.name === 'week-plan')).toMatchObject({
      status: 'armed',
      ageSeconds: null,
    });
  });
});

describe('heartbeat ledger (real DDL)', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.close();
  });

  it('stamp inserts on first sight and advances on the next run', async () => {
    await stampCronHeartbeat(testDb.database, 'drain');
    const [first] = await testDb.database.select().from(schema.cronHeartbeats);
    if (!first) throw new Error('stamp wrote no row');

    await new Promise((resolve) => setTimeout(resolve, 5));
    await stampCronHeartbeat(testDb.database, 'drain');
    const rows = await testDb.database.select().from(schema.cronHeartbeats);
    expect(rows).toHaveLength(1);
    const second = rows[0];
    if (!second) throw new Error('upsert lost the row');
    expect(second.lastRanAt.getTime()).toBeGreaterThan(first.lastRanAt.getTime());
  });

  it('arming creates missing rows and never touches an existing stamp', async () => {
    const [before] = await testDb.database.select().from(schema.cronHeartbeats);
    if (!before) throw new Error('expected the drain row from the previous test');

    await armCronHeartbeats(testDb.database, ['drain', 'discovery']);

    const rows = await testDb.database.select().from(schema.cronHeartbeats);
    expect(rows.map((row) => row.name).sort()).toEqual(['discovery', 'drain']);
    const drain = rows.find((row) => row.name === 'drain');
    expect(drain?.lastRanAt.getTime()).toBe(before.lastRanAt.getTime());
  });
});

describe('MUTATION JOURNEY: freeze a stamp → report goes stale → the real checker fires', () => {
  let testDb: TestDb;

  beforeAll(async () => {
    testDb = await createTestDb();
  });

  afterAll(async () => {
    await testDb.close();
  });

  it('walks the whole switch against the real manifest and the real checker script', async () => {
    const entries = manifest();

    // Every scheduled cron stamps, as the cronRoute wrapper would.
    for (const { path } of entries) {
      await stampCronHeartbeat(testDb.database, cronSlug(path));
    }

    const fresh = assessCronHealth(
      entries,
      await testDb.database.select().from(schema.cronHeartbeats),
      new Date(),
    );
    expect(fresh.ok).toBe(true);
    expect(fresh.crons).toHaveLength(entries.length);

    // POSITIVE CONTROL: the checker passes the fresh report.
    const freshBody = JSON.stringify({ ok: fresh.ok, crons: fresh.crons });
    const pass = runChecker(200, freshBody);
    expect(pass.exitCode).toBe(0);
    expect(pass.output).toContain(`all ${entries.length} crons fresh`);

    // FREEZE one stamp: the drain last ran two hours ago (limit is ~17 min).
    await testDb.exec(
      `UPDATE cron_heartbeats SET last_ran_at = now() - interval '2 hours' WHERE name = 'drain'`,
    );

    const stale = assessCronHealth(
      entries,
      await testDb.database.select().from(schema.cronHeartbeats),
      new Date(),
    );
    expect(stale.ok).toBe(false);
    const staleNames = stale.crons.filter((cron) => cron.status === 'stale');
    expect(staleNames.map((cron) => cron.name)).toEqual(['drain']);

    // THE CHECKER'S PARSE FIRES: exit 1, naming the frozen cron.
    const staleBody = JSON.stringify({ ok: stale.ok, crons: stale.crons });
    const alarm = runChecker(200, staleBody);
    expect(alarm.exitCode).toBe(1);
    expect(alarm.output).toContain('ALARM');
    expect(alarm.output).toContain('drain');
  });

  it('a refusal is not evidence: non-200, unparseable, and empty verdicts all alarm', () => {
    expect(runChecker(503, JSON.stringify({ ok: false, error: 'db_unreachable' })).exitCode).toBe(
      1,
    );
    expect(runChecker(200, 'not json').exitCode).toBe(1);
    // A body that says nothing must never read as healthy.
    expect(runChecker(200, JSON.stringify({ ok: true, crons: [] })).exitCode).toBe(1);
  });
});
