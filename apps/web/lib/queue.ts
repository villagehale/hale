import PgBoss from 'pg-boss';

let cachedBoss: PgBoss | undefined;
let startPromise: Promise<PgBoss> | undefined;

/**
 * Returns a started pg-boss instance. The web app only enqueues; the worker
 * service is the consumer.
 */
export async function getQueue(): Promise<PgBoss> {
  if (cachedBoss) {
    return cachedBoss;
  }

  if (!startPromise) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL is not set');
    }
    startPromise = (async () => {
      const boss = new PgBoss({
        connectionString: url,
        // Keep the web app's queue role lean — it only sends.
        schema: 'pgboss',
      });
      await boss.start();
      cachedBoss = boss;
      return boss;
    })();
  }

  return startPromise;
}
