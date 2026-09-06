import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';

/** How far back a failed arm still counts as news on the Radar. */
const ARM_FAILURE_WINDOW_HOURS = 24;

/**
 * The watched-spots table has no status column — live is `released_at IS NULL`, a held
 * observation is `pending_kind IS NOT NULL`, a text awaiting its receipt is
 * `notified_message_id IS NOT NULL` — so every number here is a predicate over those
 * three, never a stored state that could disagree with them.
 */
export interface WatchedSpotsData {
  /** Watches still being read. */
  live: number;
  /** Openings Hale has found and has not yet been allowed to say — the number that
   * matters at 07:00. A text already on its way is not one of them. */
  pending: number;
  /** Live watches whose last read failed. */
  unreadable: number;
  /** The freshest read across LIVE spots: the sweep firing is a different clock
   * (`/api/health/crons`); this one says a page was reached. */
  lastPolledAt: string | null;
  /** "Told but not watching" — `armWatchedSpot`'s failure path is an audit row rather
   * than an exception, so this is the only place that count surfaces. */
  armFailures24h: number;
}

export async function loadWatchedSpots(
  database: Database = defaultDb(),
): Promise<WatchedSpotsData> {
  const w = schema.watchedSpots;
  const live = sql`${w.releasedAt} is null`;

  const [counts] = await database
    .select({
      live: sql<number>`count(*) filter (where ${live})::int`,
      pending: sql<number>`count(*) filter (where ${live} and ${w.pendingKind} is not null and ${w.notifiedMessageId} is null)::int`,
      unreadable: sql<number>`count(*) filter (where ${live} and ${w.consecutiveFailures} > 0)::int`,
      lastPolledAt: sql<
        string | null
      >`to_char(max(${w.lastPolledAt}) filter (where ${live}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`,
    })
    .from(w);

  const a = schema.auditLog;
  const [armFailures] = await database
    .select({ count: sql<number>`count(*)::int` })
    .from(a)
    .where(
      sql`${a.actionTaken} = 'watched_spot_arm_failed' and ${a.occurredAt} >= now() - make_interval(hours => ${ARM_FAILURE_WINDOW_HOURS})`,
    );

  return {
    live: counts?.live ?? 0,
    pending: counts?.pending ?? 0,
    unreadable: counts?.unreadable ?? 0,
    lastPolledAt: counts?.lastPolledAt ?? null,
    armFailures24h: armFailures?.count ?? 0,
  };
}
