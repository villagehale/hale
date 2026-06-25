import PgBoss from 'pg-boss';

/**
 * pg-boss queue maintenance (recipe #2, NON-OPTIONAL). The Fly worker, which
 * normally runs pg-boss with supervision, is not deployed — so nothing expires
 * stuck `active` jobs or archives completed ones. Without periodic maintenance a
 * pipeline that crashed mid-job leaks an `active` row forever and that job never
 * re-runs. This runs boss.maintain() on a schedule to reap them.
 *
 * Same connection choice as the drain (recipe #4): the direct/session 5432 URL,
 * because pg-boss's maintenance uses prepared statements the 6543 transaction
 * pooler breaks.
 */
export async function runQueueMaintenanceCron(): Promise<void> {
  const connectionString = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_DIRECT_URL or DATABASE_URL must be set for queue maintenance');
  }

  const boss = new PgBoss({ connectionString, schema: 'pgboss', supervise: true });
  await boss.start();
  try {
    await boss.maintain();
  } finally {
    await boss.stop({ graceful: true });
  }
}
