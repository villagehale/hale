import PgBoss from 'pg-boss';
import { queueSchema } from '~/lib/preview/family-scope';

/**
 * pg-boss queue maintenance (recipe #2, NON-OPTIONAL). The drain runs pg-boss
 * with supervision off and calls `boss.expire()` itself before each fetch, so a
 * stuck `active` job is failed or retried without waiting for this cron. This
 * run still calls `boss.maintain()` — that expire, plus archive and purge — on
 * the schedule in vercel.json. Without the archive half, completed rows would
 * accumulate. The production cron schedule is unchanged.
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

  const boss = new PgBoss({ connectionString, schema: queueSchema(), supervise: true });
  await boss.start();
  try {
    await boss.maintain();
  } finally {
    await boss.stop({ graceful: true });
  }
}
