import type { Database } from '@hale/db';
import { inArray, sql } from 'drizzle-orm';
import { pgSchema, text, timestamp } from 'drizzle-orm/pg-core';
import { INBOUND_TURN_QUEUES } from '~/lib/channel/config';
import { INBOUND_LANE_STALL_SECONDS } from '~/lib/cron/deadman';
import { PROD_QUEUE_SCHEMA } from '~/lib/preview/family-scope';

/**
 * VIL-535 — the inbound queue, as the daily #ops post reports it.
 *
 * Reads production's pg-boss schema (`pgboss`), the same table the unauthenticated
 * health lane reads. The daily post runs on production (Preview skips it) and is
 * about real families, whose turns sit in that schema. Preview's `pgboss_preview`
 * is a different queue and is not this number.
 *
 * Counts only. No job id, no singleton key, no payload. A missing table is
 * `readable: false`, which the post names as `unreadable` — not a healthy zero.
 */

/** A drizzle view of the columns this read needs. pg-boss owns the table. */
const pgbossJob = pgSchema(PROD_QUEUE_SCHEMA).table('job', {
  name: text('name').notNull(),
  state: text('state').notNull(),
  createdOn: timestamp('created_on', { withTimezone: true }).notNull(),
  startedOn: timestamp('started_on', { withTimezone: true }),
});

export interface InboundQueueSnapshot {
  /** False when `pgboss.job` could not be read. The counts are then meaningless. */
  readable: boolean;
  /** `active` jobs whose `expire_in` has already elapsed. The stuck state. */
  expiredActive: number;
  /** `created` + `retry` + `active`. */
  unfinished: number;
  /** Seconds since the oldest unfinished job was created. Null when there are none. */
  oldestSeconds: number | null;
}

export const INBOUND_QUEUE_UNREADABLE: InboundQueueSnapshot = {
  readable: false,
  expiredActive: 0,
  unfinished: 0,
  oldestSeconds: null,
};

/** The same ten minutes the health lane calls stale, plus any expired-active job
 * (those are stuck at 180s, well inside the lane's window). */
export function inboundQueueIsStalled(queue: InboundQueueSnapshot): boolean {
  if (!queue.readable) return false;
  if (queue.expiredActive > 0) return true;
  return queue.oldestSeconds !== null && queue.oldestSeconds > INBOUND_LANE_STALL_SECONDS;
}

function asInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  return asInt(value);
}

/** The driver error carries the SQL text and its bound parameters, so only its
 * class is logged. */
function errorClass(err: unknown): { code: string | null; name: string } {
  if (!(err instanceof Error)) return { code: null, name: typeof err };
  const code = (err as { code?: unknown }).code;
  return { code: typeof code === 'string' ? code : null, name: err.name };
}

/**
 * One aggregate over the inbound queues. `state` is compared to SQL literals:
 * the column is pg-boss's enum, and a bound text parameter would need a cast
 * (the same constraint as app/api/health/crons). `expire_in` is unqualified
 * because this select has one table.
 */
export async function loadInboundQueueStall(database: Database): Promise<InboundQueueSnapshot> {
  const live = sql`${pgbossJob.state} in ('created', 'retry', 'active')`;
  try {
    const [row] = await database
      .select({
        expiredActive: sql<number>`count(*) filter (where ${pgbossJob.state} = 'active' and ${pgbossJob.startedOn} + expire_in < now())::int`,
        unfinished: sql<number>`count(*) filter (where ${live})::int`,
        oldestSeconds: sql<
          number | null
        >`extract(epoch from (now() - min(${pgbossJob.createdOn}) filter (where ${live})))::int`,
      })
      .from(pgbossJob)
      .where(inArray(pgbossJob.name, [...INBOUND_TURN_QUEUES]));
    return {
      readable: true,
      expiredActive: asInt(row?.expiredActive),
      unfinished: asInt(row?.unfinished),
      oldestSeconds: asIntOrNull(row?.oldestSeconds),
    };
  } catch (err) {
    console.error('ops daily: inbound queue unreadable', errorClass(err));
    return INBOUND_QUEUE_UNREADABLE;
  }
}
