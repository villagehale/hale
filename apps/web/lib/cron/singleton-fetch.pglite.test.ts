import { createQueueWithPolicy } from '@hale/tools-contracts';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CHANNEL_MESSAGE_RECEIVED_DLQ,
  CHANNEL_MESSAGE_RECEIVED_EXPIRE_SECONDS,
  CHANNEL_MESSAGE_RECEIVED_POLICY,
  CHANNEL_MESSAGE_RECEIVED_QUEUE,
  CHANNEL_MESSAGE_RECEIVED_RETRY,
} from '~/lib/channel/config';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import {
  bindInboundQueue,
  countExpiredActive,
  fetchSingletonSkippingHeldKeys,
} from '~/lib/cron/singleton-fetch';
import { loadInboundQueueStall } from '~/lib/monitoring/inbound-queue-stall';
import { type TestDb, createTestDb } from '~/lib/testing/pglite';

/**
 * VIL-535 — the real pg-boss, on pglite. One expired active job on the singleton
 * queue used to make every family's fetch return nothing until queue-maintenance
 * ran `boss.maintain()`. These tests are that incident: the library fetch, the
 * claim that skips a held key, and `expire()` moving the stuck job off `active`.
 */

const PARENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const PARENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const QUEUE = CHANNEL_MESSAGE_RECEIVED_QUEUE;

let db: TestDb;
let boss: PgBoss;

async function bootPgBoss(): Promise<PgBoss> {
  const started = new PgBoss({
    schema: 'pgboss',
    supervise: false,
    schedule: false,
    db: {
      async executeSql(text: string, values?: unknown[]) {
        if (values && values.length > 0) return await db.client.query(text, values);
        const results = await db.client.exec(text);
        return results.at(-1) ?? { rows: [] };
      },
    },
  } as never);
  await started.start();
  await createQueueWithPolicy(started, QUEUE, {
    expireInSeconds: CHANNEL_MESSAGE_RECEIVED_EXPIRE_SECONDS,
    policy: CHANNEL_MESSAGE_RECEIVED_POLICY,
    retry: CHANNEL_MESSAGE_RECEIVED_RETRY,
    deadLetter: CHANNEL_MESSAGE_RECEIVED_DLQ,
  });
  return started;
}

beforeAll(async () => {
  db = await createTestDb();
  boss = await bootPgBoss();
}, 120_000);

afterAll(async () => {
  await boss.stop({ wait: false });
  await db.close();
});

beforeEach(async () => {
  await db.exec('delete from pgboss.job');
});

async function send(parent: string, n: number): Promise<string> {
  const id = crypto.randomUUID();
  const created = await boss.send(
    QUEUE,
    { parent, n },
    {
      id,
      singletonKey: channelSmsNoteKey(parent),
      expireInSeconds: CHANNEL_MESSAGE_RECEIVED_EXPIRE_SECONDS,
    },
  );
  if (!created) throw new Error(`pg-boss created no job for ${parent} #${n}`);
  return created;
}

async function makeDue(): Promise<void> {
  await db.exec(
    "update pgboss.job set start_after = now() - interval '1 minute' where state in ('created', 'retry')",
  );
}

async function states(): Promise<
  Array<{ id: string; state: string; singleton_key: string | null }>
> {
  const res = await db.client.query<{ id: string; state: string; singleton_key: string | null }>(
    'select id, state::text as state, singleton_key from pgboss.job order by created_on, id',
  );
  return res.rows;
}

describe('channel.message.received singleton isolation', () => {
  it('keeps per-parent order and does not let one held key block another parent', async () => {
    const first = await send(PARENT_A, 1);
    const second = await send(PARENT_A, 2);
    const other = await send(PARENT_B, 1);
    await makeDue();

    const claimed = await fetchSingletonSkippingHeldKeys<{ parent: string; n: number }>(
      boss.getDb(),
      'pgboss',
      QUEUE,
      10,
    );
    expect(claimed.map((job) => job.id)).toEqual([first, other]);
    expect(claimed.map((job) => job.data.n)).toEqual([1, 1]);

    const stillWaiting = (await states()).find((row) => row.id === second);
    expect(stillWaiting?.state).toBe('created');

    await boss.complete(QUEUE, first);
    await makeDue();
    const next = await fetchSingletonSkippingHeldKeys<{ n: number }>(
      boss.getDb(),
      'pgboss',
      QUEUE,
      10,
    );
    expect(next.map((job) => job.id)).toEqual([second]);
  });

  it('reaps an expired active job on the drain path, and the other parent never waited on queue-maintenance', async () => {
    const stuck = await send(PARENT_A, 1);
    const queuedSameParent = await send(PARENT_A, 2);
    const other = await send(PARENT_B, 1);
    await makeDue();

    const [activated] = await boss.fetch<{ parent: string }>(QUEUE, { batchSize: 1 });
    expect(activated?.id).toBe(stuck);

    // The library fetch: the next row is the same key, the unique index aborts
    // the whole batch, and the other parent comes back as an empty queue.
    await db.client.query(
      "update pgboss.job set started_on = now() - interval '1 hour' where id = $1",
      [stuck],
    );
    const poisoned = await boss.fetch(QUEUE, { batchSize: 10 });
    expect(poisoned).toEqual([]);
    expect(await countExpiredActive(boss.getDb(), 'pgboss', QUEUE)).toBe(1);

    const stall = await loadInboundQueueStall(db.database);
    expect(stall.readable).toBe(true);
    expect(stall.expiredActive).toBe(1);
    expect(stall.unfinished).toBe(3);

    const bound = bindInboundQueue(boss);
    const whileStuck = await bound.fetch<{ parent: string }>(QUEUE, { batchSize: 10 });
    expect(whileStuck.map((job) => job.id)).toEqual([other]);
    expect((await states()).find((row) => row.id === queuedSameParent)?.state).toBe('created');

    // The drain calls this. Nothing here hits /api/cron/queue-maintenance.
    expect(await bound.expire()).toBe(1);
    expect(await countExpiredActive(boss.getDb(), 'pgboss', QUEUE)).toBe(0);
    const after = (await states()).find((row) => row.id === stuck);
    expect(after?.state).toBe('retry');

    await makeDue();
    // The retried original is still the oldest row for that parent, so it goes
    // before the text that arrived while it was stuck.
    const resumed = await bound.fetch<{ parent: string }>(QUEUE, { batchSize: 10 });
    expect(resumed.map((job) => job.id)).toEqual([stuck]);
    expect((await states()).find((row) => row.id === queuedSameParent)?.state).toBe('created');
  });

  it('treats a null singleton key as its own slot, not a lock on every family', async () => {
    const globalId = crypto.randomUUID();
    await boss.send(QUEUE, { parent: 'none', n: 1 }, { id: globalId });
    const globalQueued = crypto.randomUUID();
    await boss.send(QUEUE, { parent: 'none', n: 2 }, { id: globalQueued });
    const other = await send(PARENT_B, 1);
    await makeDue();

    const [activated] = await boss.fetch(QUEUE, { batchSize: 1 });
    expect(activated?.id).toBe(globalId);

    const poisoned = await boss.fetch(QUEUE, { batchSize: 10 });
    expect(poisoned).toEqual([]);

    const claimed = await fetchSingletonSkippingHeldKeys<{ parent: string }>(
      boss.getDb(),
      'pgboss',
      QUEUE,
      10,
    );
    expect(claimed.map((job) => job.id)).toEqual([other]);
  });

  it('reports a clear queue as readable zeros', async () => {
    const stall = await loadInboundQueueStall(db.database);
    expect(stall).toEqual({
      readable: true,
      expiredActive: 0,
      unfinished: 0,
      oldestSeconds: null,
    });
  });
});
