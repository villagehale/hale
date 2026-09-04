/**
 * Dead-man switch staleness assessment (audit P1-8).
 *
 * Every watchdog Hale has — the drain, the Twilio triage, the delivery sweep,
 * the digests — runs on the same Vercel cron substrate it monitors, so "crons
 * stopped" silences its own alarm. The cure is a liveness fact that lives
 * OUTSIDE the substrate's failure domain: each cron stamps `cron_heartbeats`
 * on completion (through the shared `cronRoute` wrapper), this module turns
 * those stamps plus the schedule manifest into an ok/stale verdict, and a
 * GitHub Actions checker reads the verdict from off-Vercel.
 *
 * The manifest of record is apps/web/vercel.json — the file the platform
 * itself reads — imported by the health route rather than copied into a
 * constant that would drift. This module only PARSES it.
 */

export interface CronManifestEntry {
  path: string;
  schedule: string;
}

export interface HeartbeatRow {
  name: string;
  lastRanAt: Date;
}

/**
 * `armed` = the ledger has never seen this cron (no row). The caller inserts a
 * baseline row at now() — arming starts the clock, so a cron that never runs
 * trips `stale` one threshold later instead of paging falsely the moment it is
 * scheduled (the weekly crons would otherwise page for up to a week after this
 * feature ships). Arming cannot hide a route that forgot to stamp: the guard
 * test (heartbeat-guard.test.ts) makes an unstamping cron route unbuildable.
 */
export type CronHealthStatus = 'ok' | 'stale' | 'armed';

export interface CronHealth {
  name: string;
  status: CronHealthStatus;
  /** Seconds since the last stamp; null when armed (never stamped). */
  ageSeconds: number | null;
  /** The age at which this cron reads stale, from its declared cadence. */
  staleAfterSeconds: number;
}

export interface CronHealthReport {
  ok: boolean;
  crons: CronHealth[];
}

/** '/api/cron/drain' → 'drain' — the ledger key a route stamps under. */
export function cronSlug(path: string): string {
  const slug = path.split('/').at(-1);
  if (!slug || !path.startsWith('/api/cron/')) {
    throw new Error(`not a cron path: ${path}`);
  }
  return slug;
}

/**
 * The worst-case seconds between two fires of a schedule, classified from the
 * shapes vercel.json actually uses (the same shapes vercel-crons.test.ts
 * polices): every-minute, stepped minutes (`*​/N`, `A-59/N`), hourly (fixed
 * minute), daily (fixed minute+hour), weekly (fixed day-of-week). A shape this
 * function does not recognize throws — a new cadence must be classified here
 * deliberately, never guessed at.
 */
export function schedulePeriodSeconds(schedule: string): number {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`unrecognized cron schedule: ${schedule}`);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (dayOfMonth !== '*' || month !== '*') {
    throw new Error(`unrecognized cron schedule (day-of-month/month): ${schedule}`);
  }

  if (minute === '*') return 60;
  const stepped = /^(?:\*|\d+-59)\/(\d+)$/.exec(minute);
  if (stepped) return Number(stepped[1]) * 60;
  if (!/^\d+$/.test(minute)) throw new Error(`unrecognized cron minute field: ${schedule}`);

  if (hour === '*') return 60 * 60;
  if (!/^\d+$/.test(hour)) throw new Error(`unrecognized cron hour field: ${schedule}`);

  if (dayOfWeek === '*') return 24 * 60 * 60;
  if (!/^\d$/.test(dayOfWeek)) throw new Error(`unrecognized cron day-of-week field: ${schedule}`);
  return 7 * 24 * 60 * 60;
}

/**
 * Two missed fires plus fifteen minutes: one missed slot must never page (a
 * deploy, a lagging scheduler, a long run all eat a slot), and the grace
 * covers the longest handler (drain's maxDuration is 800s and the stamp lands
 * at COMPLETION, not at invocation).
 */
export const STALE_GRACE_SECONDS = 15 * 60;

export function staleAfterSeconds(schedule: string): number {
  return schedulePeriodSeconds(schedule) * 2 + STALE_GRACE_SECONDS;
}

/**
 * The verdict the health endpoint publishes and the off-Vercel checker reads.
 * Names and ages only — no error text, no counts, no family data (rule #1: the
 * endpoint is unauthenticated, so it must be unrevealing).
 */
export function assessCronHealth(
  manifest: readonly CronManifestEntry[],
  rows: readonly HeartbeatRow[],
  now: Date,
): CronHealthReport {
  const byName = new Map(rows.map((row) => [row.name, row]));
  const crons = manifest.map(({ path, schedule }): CronHealth => {
    const name = cronSlug(path);
    const limit = staleAfterSeconds(schedule);
    const row = byName.get(name);
    if (!row) return { name, status: 'armed', ageSeconds: null, staleAfterSeconds: limit };
    const age = Math.floor((now.getTime() - row.lastRanAt.getTime()) / 1000);
    return {
      name,
      status: age > limit ? 'stale' : 'ok',
      ageSeconds: age,
      staleAfterSeconds: limit,
    };
  });
  return { ok: crons.every((cron) => cron.status !== 'stale'), crons };
}
