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

vi.mock('pg-boss', () => ({
  default: class {
    start = start;
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
    process.env.DATABASE_URL = 'postgres://stub/queue-test';
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
