import { describe, expect, it } from 'vitest';
import {
  type QueueCreateOptions,
  createQueueWithPolicy,
} from './queue-policy';

/**
 * The queue-policy invariant's engine room. Three properties, each one a prod incident
 * shape:
 *  - dead letter FIRST (pg-boss's `dead_letter` is a foreign key onto `queue(name)`);
 *  - the retry policy and dead letter ride the SAME options object on create AND update
 *    (`create_queue` ends in ON CONFLICT DO NOTHING, so update is what converges a
 *    queue that already exists on production with pg-boss defaults — the landmine the
 *    inbound turn queue already stepped on once, channel/twilio/deps.ts);
 *  - nothing optional about any of it: the spec type requires retry + deadLetter, so a
 *    caller cannot express a bare queue at all.
 */

function fakeBoss() {
  const created: QueueCreateOptions[] = [];
  const updated: QueueCreateOptions[] = [];
  return {
    created,
    updated,
    async createQueue(name: string, options?: QueueCreateOptions) {
      created.push({ ...options, name });
    },
    async updateQueue(name: string, options?: QueueCreateOptions) {
      updated.push({ ...options, name });
    },
  };
}

const RETRY = { retryLimit: 8, retryDelay: 15, retryBackoff: true } as const;

describe('createQueueWithPolicy', () => {
  it('creates the dead-letter queue before the queue that names it', async () => {
    const boss = fakeBoss();
    await createQueueWithPolicy(boss, 'q', { retry: RETRY, deadLetter: 'q.dead' });

    const names = boss.created.map((c) => c.name);
    expect(names.indexOf('q.dead')).toBeGreaterThanOrEqual(0);
    expect(names.indexOf('q.dead')).toBeLessThan(names.indexOf('q'));
  });

  it("gives the dead letter the queue's own retry arc (its consumer can throw too), and no dead letter of its own", async () => {
    const boss = fakeBoss();
    await createQueueWithPolicy(boss, 'q', { retry: RETRY, deadLetter: 'q.dead' });

    expect(boss.created).toContainEqual({ name: 'q.dead', ...RETRY });
  });

  it('declares the queue with the explicit retry policy and its dead letter', async () => {
    const boss = fakeBoss();
    await createQueueWithPolicy(boss, 'q', {
      expireInSeconds: 180,
      policy: 'singleton',
      retry: RETRY,
      deadLetter: 'q.dead',
    });

    expect(boss.created).toContainEqual({
      name: 'q',
      expireInSeconds: 180,
      policy: 'singleton',
      ...RETRY,
      deadLetter: 'q.dead',
    });
  });

  it('CONVERGES an existing queue: update carries the identical options as create, for the pair', async () => {
    const boss = fakeBoss();
    await createQueueWithPolicy(boss, 'q', {
      expireInSeconds: 60,
      retry: { retryLimit: 2, retryDelay: 15, retryBackoff: true },
      deadLetter: 'q.dead',
    });

    expect(boss.updated).toEqual(boss.created);
  });
});
