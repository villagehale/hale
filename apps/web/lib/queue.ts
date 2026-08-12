import PgBoss from 'pg-boss';

let cachedBoss: PgBoss | undefined;
let startPromise: Promise<PgBoss> | undefined;

/**
 * Returns a started pg-boss instance. The web app only enqueues; the worker
 * service is the consumer.
 *
 * The in-flight start is memoized so concurrent enqueues share one connection — but
 * ONLY while it is in flight or resolved. A REJECTED start is evicted, because a
 * memoized rejection is not a cache, it is a poisoned lambda: one transient
 * `boss.start()` failure (a pool blip during a drain tick) would otherwise re-reject
 * every enqueue for the rest of that instance's life, long after the pool recovered.
 * On the Twilio inbound path that is the difference between a retried text and a
 * swallowed one.
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
    const attempt = (async () => {
      const boss = new PgBoss({
        connectionString: url,
        // Keep the web app's queue role lean — it only sends.
        schema: 'pgboss',
      });
      await boss.start();
      cachedBoss = boss;
      return boss;
    })();
    const guarded: Promise<PgBoss> = attempt.catch((err) => {
      if (startPromise === guarded) startPromise = undefined;
      throw err;
    });
    startPromise = guarded;
  }

  return startPromise;
}
