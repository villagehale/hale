import type PgBoss from 'pg-boss';
import { CHANNEL_MESSAGE_RECEIVED_QUEUE } from '~/lib/channel/config';
import { PREVIEW_QUEUE_SCHEMA, PROD_QUEUE_SCHEMA, queueSchema } from '~/lib/preview/family-scope';

/**
 * VIL-535 — claim inbound turns without letting one singleton key stall the queue.
 *
 * pg-boss 10.4.2's `fetchNextJob` (plans.js) LIMITs a batch, then activates every
 * selected row whose key is unique inside that batch. It does not look at keys that
 * are already `active`. The singleton unique index is
 * `(name, coalesce(singleton_key, '')) WHERE state = 'active'`. One already-active
 * key in the batch raises `23505`, the fetch swallows it, and the whole batch —
 * every other family in it — comes back empty. Drains then log `processed: 0`
 * until something calls `boss.expire()` / `maintain()`.
 *
 * Preview never runs Vercel crons, so that something was a manual
 * `/api/cron/queue-maintenance`. The drain now expires before it fetches, and this
 * claim skips held keys before it takes a row, one job at a time, so a conflict
 * loses only the key that raced and the rest of the batch still lands.
 *
 * The key itself stays per parent (`channelSmsNoteKey` in inbound-deps.ts). That is
 * stricter than one key per family: a co-parent does not wait behind the other
 * parent, and a different family cannot share the slot. A null key is its own slot
 * (`coalesce(..., '')`), matching the index, and does not lock keyed jobs.
 */

const ALLOWED_SCHEMAS = new Set<string>([PROD_QUEUE_SCHEMA, PREVIEW_QUEUE_SCHEMA]);

/** The slice of pg-boss's db the claim uses. The real `getDb()` and the pglite
 * adapter in tests both satisfy it. */
export interface QueueSql {
  executeSql(text: string, values: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Schema names are interpolated. Only the two Hale pg-boss schemas are allowed. */
export function assertQueueSchema(schema: string): string {
  if (!ALLOWED_SCHEMAS.has(schema)) {
    throw new Error('refusing queue schema outside pgboss and pgboss_preview');
  }
  return schema;
}

function claimOneSql(schema: string): string {
  return `
    WITH next AS (
      SELECT j.id
      FROM ${schema}.job j
      WHERE j.name = $1
        AND j.state < 'active'
        AND j.start_after < now()
        AND NOT EXISTS (
          SELECT 1
          FROM ${schema}.job active
          WHERE active.name = j.name
            AND active.state = 'active'
            AND COALESCE(active.singleton_key, '') = COALESCE(j.singleton_key, '')
        )
      ORDER BY j.priority DESC, j.created_on, j.id
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE ${schema}.job j SET
      state = 'active',
      started_on = now(),
      retry_count = CASE WHEN j.started_on IS NOT NULL THEN j.retry_count + 1 ELSE j.retry_count END
    FROM next
    WHERE j.name = $1 AND j.id = next.id
    RETURNING j.id, j.data
  `;
}

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: unknown }).code === '23505') return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause !== undefined && isUniqueViolation(cause);
}

/**
 * Activate up to `batchSize` jobs whose singleton key is not already active.
 * One statement per job: a unique-index race retries the next free key instead
 * of throwing away the batch.
 */
export async function fetchSingletonSkippingHeldKeys<T>(
  db: QueueSql,
  schema: string,
  queue: string,
  batchSize: number,
): Promise<Array<{ id: string; data: T }>> {
  const safe = assertQueueSchema(schema);
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('batchSize must be a positive integer');
  }
  const sql = claimOneSql(safe);
  const taken: Array<{ id: string; data: T }> = [];
  let races = 0;
  while (taken.length < batchSize) {
    try {
      const { rows } = await db.executeSql(sql, [queue]);
      const row = rows[0];
      if (!row) return taken;
      taken.push({ id: String(row.id), data: row.data as T });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      races += 1;
      if (races > batchSize) return taken;
    }
  }
  return taken;
}

/** Inbound jobs pg-boss would fail or retry on the next `expire()`. */
export async function countExpiredActive(
  db: QueueSql,
  schema: string,
  queue: string,
): Promise<number> {
  const safe = assertQueueSchema(schema);
  const { rows } = await db.executeSql(
    `SELECT count(*)::int AS n
     FROM ${safe}.job
     WHERE name = $1
       AND state = 'active'
       AND started_on + expire_in < now()`,
    [queue],
  );
  const n = rows[0]?.n;
  const parsed = typeof n === 'number' ? n : Number(n ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The two methods the drain adds on top of pg-boss's own fetch and maintain.
 *
 * `expire` is pg-boss's timeout sweep (fail or retry, then the queue's dead
 * letter when the retries are spent). It runs on every drain, including a
 * kicked one, so a stuck active job does not wait for `/api/cron/queue-maintenance`.
 * `fetch` uses {@link fetchSingletonSkippingHeldKeys} for the inbound queue and
 * pg-boss's fetch for every other queue.
 */
export function bindInboundQueue(boss: PgBoss): {
  fetch<T>(name: string, options: { batchSize: number }): Promise<Array<{ id: string; data: T }>>;
  expire(): Promise<number>;
} {
  const db = boss.getDb();
  return {
    async fetch<T>(name: string, options: { batchSize: number }) {
      if (name !== CHANNEL_MESSAGE_RECEIVED_QUEUE) {
        const rows = await boss.fetch<T>(name, options);
        return rows.map((row) => ({ id: row.id, data: row.data as T }));
      }
      return fetchSingletonSkippingHeldKeys<T>(db, queueSchema(), name, options.batchSize);
    },
    async expire() {
      const schema = assertQueueSchema(queueSchema());
      const expiredActive = await countExpiredActive(db, schema, CHANNEL_MESSAGE_RECEIVED_QUEUE);
      await boss.expire();
      if (expiredActive > 0) {
        console.error(
          { queue: CHANNEL_MESSAGE_RECEIVED_QUEUE, expiredActive },
          'drain: reaped inbound jobs that stayed active past their expiry',
        );
      }
      return expiredActive;
    },
  };
}
