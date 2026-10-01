import { type Database, schema } from '@hale/db';
import { sql } from 'drizzle-orm';
import { db as defaultDb } from '~/lib/db';
import { TREND_DAYS } from '../window';
import { torontoDay } from './day';

/**
 * Failure CLASSES, not rows — the Operations landing. Day-grain over the full
 * trend window so the dial slices client-side; two grouped queries (failed
 * sends by channel × code, failed agent runs by agent × status) folded
 * server-side into one shape. Labels are the same privacy-clean vocabulary
 * loadDbErrors emits: codes, channels and agent names only — no bodies, no
 * numbers (rule #1).
 */
export interface ErrorClassDay {
  day: string;
  count: number;
}

export interface ErrorClass {
  /** `twilio` remains so a historical admin row still types. Nothing live writes it. */
  source: 'message' | 'agent' | 'twilio';
  code: string;
  label: string;
  /** Count over the trend window. */
  total: number;
  /** Last seen, ISO UTC. */
  lastAt: string;
  /** Per-day counts, sparse, oldest first. */
  days: ErrorClassDay[];
  /** False when the class has no day-complete history — a sparkline would be a lie. */
  sparkline: boolean;
}

interface GroupedRow {
  day: string;
  count: number;
  lastAt: string;
}

function fold(
  rows: readonly (GroupedRow & { cls: Pick<ErrorClass, 'source' | 'code' | 'label'> })[],
): ErrorClass[] {
  const byKey = new Map<string, ErrorClass>();
  for (const row of rows) {
    const key = `${row.cls.source}\u0000${row.cls.label}\u0000${row.cls.code}`;
    let cls = byKey.get(key);
    if (!cls) {
      cls = { ...row.cls, total: 0, lastAt: row.lastAt, days: [], sparkline: true };
      byKey.set(key, cls);
    }
    cls.total += row.count;
    if (row.lastAt > cls.lastAt) cls.lastAt = row.lastAt;
    cls.days.push({ day: row.day, count: row.count });
  }
  return [...byKey.values()];
}

const AT_FORMAT = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS"Z"'`);

export async function loadErrorClasses(database: Database = defaultDb()): Promise<ErrorClass[]> {
  const m = schema.channelMessages;
  const messageDay = torontoDay(m.createdAt);
  const failedSends = await database
    .select({
      day: messageDay,
      channel: sql<string>`${m.channel}::text`,
      code: sql<string>`coalesce(${m.errorCode}, 'failed')`,
      count: sql<number>`count(*)::int`,
      lastAt: sql<string>`to_char(max(${m.createdAt}) at time zone 'UTC', ${AT_FORMAT})`,
    })
    .from(m)
    .where(
      sql`${m.direction} = 'out' and ${m.status} = 'failed' and ${m.createdAt} >= now() - make_interval(days => ${TREND_DAYS})`,
    )
    .groupBy(messageDay, sql`${m.channel}::text`, sql`coalesce(${m.errorCode}, 'failed')`)
    .orderBy(messageDay);

  const r = schema.agentRuns;
  const runDay = torontoDay(r.startedAt);
  const failedRuns = await database
    .select({
      day: runDay,
      agent: sql<string>`${r.agentName}::text`,
      code: sql<string>`${r.status}::text`,
      count: sql<number>`count(*)::int`,
      lastAt: sql<string>`to_char(max(${r.startedAt}) at time zone 'UTC', ${AT_FORMAT})`,
    })
    .from(r)
    .where(
      sql`${r.status} in ('failed', 'timed_out', 'killed_cost') and ${r.startedAt} >= now() - make_interval(days => ${TREND_DAYS})`,
    )
    .groupBy(runDay, r.agentName, r.status)
    .orderBy(runDay);

  const messageClasses = fold(
    failedSends.map((row) => ({
      ...row,
      cls: { source: 'message' as const, code: row.code, label: `${row.channel} send failed` },
    })),
  );
  const agentClasses = fold(
    failedRuns.map((row) => ({
      ...row,
      cls: { source: 'agent' as const, code: row.code, label: row.agent },
    })),
  );
  return [...messageClasses, ...agentClasses];
}
