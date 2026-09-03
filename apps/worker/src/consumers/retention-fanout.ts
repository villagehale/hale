import type PgBoss from 'pg-boss';
import { ne } from 'drizzle-orm';
import { type Database, schema } from '@hale/db';
import { createQueueWithPolicy } from '@hale/tools-contracts';
import { db } from '../db.js';
import { logger } from '../logger.js';

/**
 * Retention scheduler — the closing leg of the retention loop. The periodic job
 * (village discovery) has a consumer but nothing ever enqueued it. This module
 * schedules cron "fan-out" jobs and, on each fire, lists the active families and
 * enqueues the existing per-family job for each one.
 *
 * pg-boss notes (v10): a queue must exist before `send()` will insert into it —
 * `send` to an unknown queue silently no-ops (its INSERT joins on the queue
 * table). `boss.work()` does NOT create the queue, so every queue this scheduler
 * touches is created explicitly here. Both `createQueue` and `schedule` upsert by
 * name, so the whole setup is idempotent and safe to run on every boot.
 *
 * Family timezone: there is no per-family timezone column today, so the local
 * week date is derived in America/Toronto (Hale's compliance baseline).
 */

export const DISCOVERY_FANOUT_QUEUE = 'village.discovery.fanout';

const DEFAULT_TIMEZONE = 'America/Toronto';

/**
 * Cron cadence (timezone-pinned via ScheduleOptions.tz): village discovery
 * weekly on Monday at 7am.
 */
const DISCOVERY_CRON = '0 7 * * 1';

const isoDateFormatter = new Map<string, Intl.DateTimeFormat>();

/** Local `YYYY-MM-DD` for `at` in `timeZone`. `en-CA` formats as ISO date. */
export function localIsoDate(at: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  let fmt = isoDateFormatter.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone,
    });
    isoDateFormatter.set(timeZone, fmt);
  }
  return fmt.format(at);
}

const weekdayFormatter = new Map<string, Intl.DateTimeFormat>();

const WEEKDAY_INDEX: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

/** The Monday (`YYYY-MM-DD`) of the local week containing `at`, in `timeZone`. */
export function weekMonday(at: Date, timeZone: string = DEFAULT_TIMEZONE): string {
  let fmt = weekdayFormatter.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone });
    weekdayFormatter.set(timeZone, fmt);
  }
  const offset = WEEKDAY_INDEX[fmt.format(at)];
  if (offset === undefined) {
    throw new Error(`weekMonday: unrecognized weekday for ${at.toISOString()} in ${timeZone}`);
  }
  const monday = new Date(at.getTime() - offset * 24 * 60 * 60 * 1000);
  return localIsoDate(monday, timeZone);
}

/**
 * Active families to fan out to: every family past the initial invite stage. A
 * family still `pending_invite` has no usable data yet, so it is skipped.
 */
export async function selectActiveFamilyIds(database: Database): Promise<string[]> {
  const rows = await database
    .select({ id: schema.families.id })
    .from(schema.families)
    .where(ne(schema.families.onboardingStage, 'pending_invite'));
  return rows.map((r) => r.id);
}

interface FanoutDeps {
  boss: Pick<PgBoss, 'send'>;
  database: Database;
  log: Pick<typeof logger, 'info'>;
  now: () => Date;
}

function defaultDeps(boss: Pick<PgBoss, 'send'>): FanoutDeps {
  return { boss, database: db(), log: logger, now: () => new Date() };
}

/** Fan out village discovery: one `village.discovery.due` job per active family. */
export async function handleDiscoveryFanout(deps: FanoutDeps): Promise<void> {
  const familyIds = await selectActiveFamilyIds(deps.database);
  const weekOf = weekMonday(deps.now());
  for (const familyId of familyIds) {
    await deps.boss.send('village.discovery.due', { familyId, weekOf });
  }
  deps.log.info({ count: familyIds.length, weekOf }, 'discovery fan-out: enqueued per-family jobs');
}

/** Queues that must exist for `send()` / scheduled fires to insert (see header). */
const ALL_QUEUES = [DISCOVERY_FANOUT_QUEUE, 'village.discovery.due'] as const;

/**
 * Explicit retry (queue-policy invariant, audit P0-3 — no queue rides pg-boss
 * defaults): pg-boss's attempt count kept, the default zero seconds between attempts
 * replaced with a backoff so one transient blip cannot burn every attempt. A discovery
 * job that spends them all dead-letters into `<queue>.dead`, consumed below.
 */
const DISCOVERY_RETRY = { retryLimit: 2, retryDelay: 15, retryBackoff: true } as const;

/** The log outcome for a discovery job that spent every retry. A DATA value. */
export const DISCOVERY_RETRIES_EXHAUSTED = 'job_retries_exhausted';

/**
 * Create the retention queues, register the fan-out consumers, and upsert the
 * cron schedules. Idempotent: the queue declarations and schedule all upsert by name.
 */
export async function registerRetentionSchedules(boss: PgBoss): Promise<void> {
  for (const queue of ALL_QUEUES) {
    await createQueueWithPolicy(boss, queue, {
      retry: DISCOVERY_RETRY,
      deadLetter: `${queue}.dead`,
    });
    // The consumed half of the invariant (rule #11): a fan-out or per-family discovery
    // job that ran out of retries is a named, counted outcome — the next weekly cron
    // fire covers the family either way, so a log line is the whole obligation.
    await boss.work(`${queue}.dead`, async ([job]) => {
      if (!job) return;
      logger.error(
        { queue: `${queue}.dead`, jobId: job.id, outcome: DISCOVERY_RETRIES_EXHAUSTED },
        'retention: job ran out of retries — dead-lettered',
      );
    });
  }

  await boss.work(DISCOVERY_FANOUT_QUEUE, async ([job]) => {
    if (!job) return;
    await handleDiscoveryFanout(defaultDeps(boss));
  });

  await boss.schedule(DISCOVERY_FANOUT_QUEUE, DISCOVERY_CRON, {}, { tz: DEFAULT_TIMEZONE });

  logger.info({ tz: DEFAULT_TIMEZONE }, 'retention schedules registered: village.discovery.fanout');
}
