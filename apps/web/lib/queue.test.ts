import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The lambda-poisoning guard.
 *
 * `getQueue` memoizes the in-flight `boss.start()` so concurrent enqueues share one
 * connection. The bug this pins: the memo also captured a REJECTED start, so a single
 * transient failure (pool exhaustion during a drain tick) made every later enqueue on
 * that lambda instance reject with the same stale error — for the instance's whole
 * lifetime. On the Twilio inbound path that turns one blip into a parent's text being
 * swallowed on every retry.
 */

const start = vi.fn();
const constructed: Array<Record<string, unknown>> = [];

vi.mock('pg-boss', () => ({
  default: class {
    start = start;
    constructor(options: Record<string, unknown>) {
      constructed.push(options);
    }
  },
}));

async function freshGetQueue() {
  vi.resetModules();
  const mod = await import('./queue');
  return mod.getQueue;
}

describe('getQueue', () => {
  beforeEach(() => {
    start.mockReset();
    constructed.length = 0;
    process.env.DATABASE_URL = 'postgres://stub/queue-test';
  });

  /**
   * THE PRODUCER IS NOT A WORKER. pg-boss defaults both its background loops ON, so
   * every warm web instance was running a maintenance supervisor (polling every 5s,
   * `maintain()` every 120s, all of them contending one advisory lock with a 30s
   * lock_timeout) and a cron scheduler — on a connection layer sized for the drain.
   * The web app only ever calls `send`. The drain already documents the right config
   * (`supervise: false` in lib/cron/drain.ts) and the queue-maintenance cron already
   * owns `maintain()`; this is the producer finally getting the same treatment.
   */
  it('starts as a pure producer — no supervisor, no scheduler', async () => {
    const getQueue = await freshGetQueue();
    start.mockResolvedValue(undefined);

    await getQueue();

    expect(constructed[0]).toMatchObject({ supervise: false, schedule: false });
  });

  it('retries the start after a failed one instead of replaying the rejection forever', async () => {
    const getQueue = await freshGetQueue();
    start.mockRejectedValueOnce(new Error('pool exhausted')).mockResolvedValue(undefined);

    await expect(getQueue()).rejects.toThrow('pool exhausted');

    // The next caller must get a REAL second attempt, not the cached rejection.
    await expect(getQueue()).resolves.toBeDefined();
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('still memoizes a successful start — one connection per instance, not one per enqueue', async () => {
    const getQueue = await freshGetQueue();
    start.mockResolvedValue(undefined);

    const [a, b] = await Promise.all([getQueue(), getQueue()]);
    expect(a).toBe(b);
    expect(start).toHaveBeenCalledTimes(1);

    await getQueue();
    expect(start).toHaveBeenCalledTimes(1);
  });
});
