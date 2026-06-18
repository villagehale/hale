import { config } from './config.js';
import { logger } from './logger.js';
import { startQueue, stopQueue } from './queue.js';
import { registerConsumers } from './consumers/index.js';
import { registerRetentionSchedules } from './consumers/retention-fanout.js';

async function main(): Promise<void> {
  logger.info({ env: config.NODE_ENV }, 'Hale worker starting');

  const boss = await startQueue();
  await registerConsumers(boss);
  await registerRetentionSchedules(boss);

  logger.info('Hale worker ready');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    await stopQueue();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
