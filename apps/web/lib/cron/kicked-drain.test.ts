import { describe, expect, it, vi } from 'vitest';
import { INBOUND_TURN_QUEUES } from '~/lib/channel/config';
import type { DrainSummary } from '~/lib/cron/drain';
import { KICKED_RUN_ATTEMPTS, runKickedDrain } from './kicked-drain';

/**
 * A kicked run has already answered 202, so nobody is told when it cannot get a database
 * connection. Under a burst that is the common way for it to fail (the pooler's 15 clients
 * are shared by every run starting at once), and the text it was kicked for then waits
 * for the next scheduled run. These pin that it tries again, briefly and spread out, and
 * that every other failure is still logged once and not retried.
 */

const summary: DrainSummary = { processed: 1, failed: 0, dropped: 0, expiredActive: 0 };

function exhausted(): Error {
  return Object.assign(new Error('sorry, too many clients already'), { code: '53300' });
}

function harness(outcomes: Array<'ok' | 'exhausted' | 'other'>) {
  const run = vi.fn(async () => {
    const next = outcomes.shift();
    if (next === 'exhausted') throw exhausted();
    if (next === 'other') throw new Error('handler blew up');
    return summary;
  });
  const sleeps: number[] = [];
  const log = { info: vi.fn(), error: vi.fn() };
  return {
    run,
    sleeps,
    log,
    deps: {
      run,
      log,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
    },
  };
}

describe('runKickedDrain', () => {
  it('runs once and logs the summary when the run succeeds', async () => {
    const h = harness(['ok']);
    await runKickedDrain(INBOUND_TURN_QUEUES, h.deps);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ processed: 1, attempts: 1 }),
      'cron/drain kicked run complete',
    );
    expect(h.log.error).not.toHaveBeenCalled();
  });

  it('tries again after a connection refusal, and the retry serves the turn', async () => {
    const h = harness(['exhausted', 'exhausted', 'ok']);
    await runKickedDrain(INBOUND_TURN_QUEUES, h.deps);
    expect(h.run).toHaveBeenCalledTimes(3);
    expect(h.sleeps).toHaveLength(2);
    // Each wait is longer than the one before, so the runs that lost one race do not all
    // come back together and lose the next.
    const [first, second] = h.sleeps as [number, number];
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(h.log.info).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 3 }),
      'cron/drain kicked run complete',
    );
  });

  it('spreads the waits by the random draw', async () => {
    const low = harness(['exhausted', 'ok']);
    await runKickedDrain(INBOUND_TURN_QUEUES, { ...low.deps, random: () => 0 });
    const high = harness(['exhausted', 'ok']);
    await runKickedDrain(INBOUND_TURN_QUEUES, { ...high.deps, random: () => 0.99 });
    expect(high.sleeps[0]).toBeGreaterThan(low.sleeps[0] as number);
  });

  it('stops after its attempts and names the refusal', async () => {
    const h = harness(Array.from({ length: KICKED_RUN_ATTEMPTS + 2 }, () => 'exhausted' as const));
    await expect(runKickedDrain(INBOUND_TURN_QUEUES, h.deps)).resolves.toBeUndefined();
    expect(h.run).toHaveBeenCalledTimes(KICKED_RUN_ATTEMPTS);
    expect(h.log.error).toHaveBeenCalledTimes(1);
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ dbUnavailable: true, attempts: KICKED_RUN_ATTEMPTS }),
      'cron/drain kicked run failed',
    );
  });

  it('does not retry any other failure', async () => {
    const h = harness(['other', 'ok']);
    await runKickedDrain(INBOUND_TURN_QUEUES, h.deps);
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
    expect(h.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ dbUnavailable: false, attempts: 1 }),
      'cron/drain kicked run failed',
    );
  });
});
