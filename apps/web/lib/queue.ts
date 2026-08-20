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
        // A PRODUCER, not a worker. Both of pg-boss's background loops default ON, so
        // every warm web instance was also a maintenance supervisor (a poll every 5s
        // plus `maintain()` every 120s, all contending one advisory lock with a 30s
        // lock_timeout that pins a pooler client while it waits) and a cron scheduler.
        // At one instance that is invisible; at a hundred warm instances it is pure
        // overhead on the same connection layer the drain needs during a burst. The
        // drain sets `supervise: false` for this reason already (lib/cron/drain.ts) and
        // the queue-maintenance cron owns `maintain()`; the producer never got the memo.
        supervise: false,
        schedule: false,
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
