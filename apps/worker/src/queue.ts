import PgBoss from 'pg-boss';
import { config } from './config.js';
import { logger } from './logger.js';

let boss: PgBoss | undefined;

export async function startQueue(): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({
    connectionString: config.DATABASE_URL,
    schema: 'pgboss',
    // The worker is a long-running consumer; allow generous batch parallelism.
    newJobCheckIntervalSeconds: 2,
  });
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'));
  await boss.start();
  logger.info('pg-boss started');
  return boss;
}

export async function stopQueue(): Promise<void> {
  if (boss) {
    await boss.stop({ graceful: true });
    boss = undefined;
  }
}

export function queue(): PgBoss {
  if (!boss) {
    throw new Error('queue not started — call startQueue() first');
  }
  return boss;
}
