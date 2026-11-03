import { createQueueWithPolicy } from '@hale/tools-contracts';
import PgBoss from 'pg-boss';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNEL_MESSAGE_RECEIVED_BATCH_SIZE,
  CHANNEL_MESSAGE_RECEIVED_DLQ,
  CHANNEL_MESSAGE_RECEIVED_EXPIRE_SECONDS,
  CHANNEL_MESSAGE_RECEIVED_POLICY,
  CHANNEL_MESSAGE_RECEIVED_QUEUE,
  CHANNEL_MESSAGE_RECEIVED_RETRY,
  TURN_DEADLINE_MS,
} from '~/lib/channel/config';
import { channelSmsNoteKey } from '~/lib/coach/note-key';
import {
  type DrainDeps,
  type DrainHandlers,
  drainBossFrom,
  drainHotQueues,
} from '~/lib/cron/drain';
import {
  type QueueSql,
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

/** pglite's clock ticks in milliseconds, so back-to-back sends can share a
 * `created_on` and the claim order would fall back to random job ids. Each test job
 * is stamped strictly after the one before it. */
let sentCount = 0;
async function stampSendOrder(id: string): Promise<void> {
  sentCount += 1;
  await db.client.query(
    "update pgboss.job set created_on = now() + $2::int * interval '1 millisecond' where id = $1",
    [id, sentCount],
  );
}

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
  await stampSendOrder(created);
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

    const { jobs: claimed } = await fetchSingletonSkippingHeldKeys<{ parent: string; n: number }>(
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
    const { jobs: next } = await fetchSingletonSkippingHeldKeys<{ n: number }>(
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
    const whileStuck = await bound.fetch<{ parent: string }>(QUEUE, {
      batchSize: CHANNEL_MESSAGE_RECEIVED_BATCH_SIZE,
    });
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
    await stampSendOrder(globalId);
    const globalQueued = crypto.randomUUID();
    await boss.send(QUEUE, { parent: 'none', n: 2 }, { id: globalQueued });
    await stampSendOrder(globalQueued);
    const other = await send(PARENT_B, 1);
    await makeDue();

    const [activated] = await boss.fetch(QUEUE, { batchSize: 1 });
    expect(activated?.id).toBe(globalId);

    const poisoned = await boss.fetch(QUEUE, { batchSize: 10 });
    expect(poisoned).toEqual([]);

    const { jobs: claimed } = await fetchSingletonSkippingHeldKeys<{ parent: string }>(
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

/**
 * Devin's finding on #999: every drain sweeps `expire()` before it fetches, so a sweep
 * must only ever catch a DEAD turn. These run the real drain over the real pg-boss
 * wiring (`drainBossFrom`); the only fake is the `channelMessage` handler port.
 */
describe('the per-drain expiry sweep', () => {
  const FAMILY = 'ffffffff-ffff-4fff-8fff-fffffffffff0';
  const PARENTS = [1, 2, 3, 4].map((n) => `cccccccc-cccc-4ccc-8ccc-cccccccccc0${n}`);
  const TURN_S = TURN_DEADLINE_MS / 1000 - 10;

  async function sendTurn(parent: string): Promise<string> {
    const created = await boss.send(
      QUEUE,
      {
        family_id: FAMILY,
        parent_user_id: parent,
        channel_message_id: crypto.randomUUID(),
        provider_message_id: `provider-${parent.slice(-2)}`,
        received_at: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        singletonKey: channelSmsNoteKey(parent),
        expireInSeconds: CHANNEL_MESSAGE_RECEIVED_EXPIRE_SECONDS,
      },
    );
    if (!created) throw new Error('pg-boss created no inbound job');
    await stampSendOrder(created);
    return created;
  }

  function drainDeps(channelMessage: DrainHandlers['channelMessage']): DrainDeps {
    const inert = async () => undefined;
    return {
      boss: drainBossFrom(boss),
      handlers: {
        runOrchestrator: inert as unknown as DrainHandlers['runOrchestrator'],
        executeApprovedAction: inert as unknown as DrainHandlers['executeApprovedAction'],
        rerank: inert,
        channelSend: inert,
        channelSendDead: inert,
        channelMessage,
        deepResearch: inert,
        autonomyNotices: inert,
      },
      log: { info: vi.fn(), error: vi.fn() },
      now: () => Date.now(),
      pageExpiredTurn: vi.fn(async () => undefined),
    };
  }

  async function jobRows(ids: string[]) {
    const res = await db.client.query<{ id: string; state: string; retry_count: number }>(
      'select id, state::text as state, retry_count from pgboss.job where id = any($1::uuid[])',
      [ids],
    );
    return ids.map((id) => {
      const row = res.rows.find((r) => r.id === id);
      return { state: row?.state, retry_count: row?.retry_count };
    });
  }

  it('never reaps a turn that a live drain still holds', async () => {
    const ids: string[] = [];
    for (const parent of PARENTS) ids.push(await sendTurn(parent));
    await makeDue();

    const sweeps: number[] = [];
    const handled: string[] = [];
    const channelMessage = vi.fn(async (job: { parent_user_id: string }) => {
      handled.push(job.parent_user_id);
      await db.client.query(
        "update pgboss.job set started_on = started_on - make_interval(secs => $2) where name = $1 and state = 'active'",
        [QUEUE, TURN_S],
      );
      sweeps.push(await bindInboundQueue(boss).expire());
    });

    const summary = await drainHotQueues(drainDeps(channelMessage));

    expect(sweeps).toEqual([0, 0, 0, 0]);
    expect(handled).toEqual(PARENTS);
    expect(summary.processed).toBe(4);
    expect(summary.dropped).toBe(0);
    expect(await jobRows(ids)).toEqual(ids.map(() => ({ state: 'completed', retry_count: 0 })));
  });

  it('still reaps a turn whose drain died, and the next parent is answered in that run', async () => {
    const [deadParent, liveParent] = PARENTS as [string, string];
    const stuck = await sendTurn(deadParent);
    await makeDue();
    const claimed = await bindInboundQueue(boss).fetch(QUEUE, { batchSize: 1 });
    expect(claimed.map((job) => job.id)).toEqual([stuck]);
    await db.client.query(
      'update pgboss.job set started_on = started_on - make_interval(secs => $2) where id = $1',
      [stuck, CHANNEL_MESSAGE_RECEIVED_EXPIRE_SECONDS + 1],
    );
    const live = await sendTurn(liveParent);
    await makeDue();

    const handled: string[] = [];
    const channelMessage = vi.fn(async (job: { parent_user_id: string }) => {
      handled.push(job.parent_user_id);
    });
    const summary = await drainHotQueues(drainDeps(channelMessage));

    expect(summary.expiredActive).toBe(1);
    expect(summary.dropped).toBe(0);
    expect(handled).toEqual([liveParent]);
    const stuckRow = await db.client.query<{ state: string; due_later: boolean }>(
      'select state::text as state, start_after > now() as due_later from pgboss.job where id = $1',
      [stuck],
    );
    expect(stuckRow.rows[0]).toEqual({ state: 'retry', due_later: true });
    expect(await jobRows([live])).toEqual([{ state: 'completed', retry_count: 0 }]);
  });

  /**
   * The drain's inbound fetch must be the key-skipping claim, not pg-boss's own. With a
   * live turn holding one parent's key and that parent's next text the oldest due row,
   * pg-boss's fetch lands on the held key, swallows the 23505 and returns nothing, so
   * the drain would stop and the other parent would wait (the 2026-09-17 shape).
   */
  it('claims past a key a live drain holds, through the production wiring', async () => {
    const [heldParent, freeParent] = PARENTS as [string, string];
    const held = await sendTurn(heldParent);
    await makeDue();
    const peer = await bindInboundQueue(boss).fetch(QUEUE, { batchSize: 1 });
    expect(peer.map((job) => job.id)).toEqual([held]);
    const heldNext = await sendTurn(heldParent);
    const free = await sendTurn(freeParent);
    await makeDue();

    const handled: string[] = [];
    const channelMessage = vi.fn(async (job: { parent_user_id: string }) => {
      handled.push(job.parent_user_id);
    });
    const summary = await drainHotQueues(drainDeps(channelMessage));

    expect(handled).toEqual([freeParent]);
    expect(summary.processed).toBe(1);
    expect(summary.expiredActive).toBe(0);
    expect(await jobRows([held, heldNext, free])).toEqual([
      { state: 'active', retry_count: 0 },
      { state: 'created', retry_count: 0 },
      { state: 'completed', retry_count: 0 },
    ]);
  });
});

/**
 * Devin's second finding on #999: a claim that loses to another drain used to give up
 * after `batchSize` lost races and hand back a short batch, so the drain read the
 * queue as empty while other parents' keys were free. `peerWins` is a QueueSql port
 * that lets a real peer claim run just before each of our first `losses` activating
 * writes (any statement that is not a SELECT), then either forwards ours or raises
 * the unique violation a committed peer produces.
 */
describe('a claim that loses to another drain', () => {
  const PARENT_C = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd3';
  const CLAIM_LOST =
    'drain: inbound claim lost races to another drain; keys skipped for this fetch';

  function peerWins(
    raw: QueueSql,
    losses: number,
    mode: 'forward' | 'unique',
  ): { db: QueueSql; intercepted: () => number } {
    let intercepted = 0;
    return {
      intercepted: () => intercepted,
      db: {
        async executeSql(text, values) {
          const activating = !/^select\b/i.test(text.trimStart());
          if (!activating || intercepted >= losses) return raw.executeSql(text, values);
          intercepted += 1;
          await fetchSingletonSkippingHeldKeys(raw, 'pgboss', QUEUE, 1);
          if (mode === 'unique') {
            throw Object.assign(new Error('duplicate key'), { code: '23505' });
          }
          return raw.executeSql(text, values);
        },
      },
    };
  }

  async function twoTextsEach(): Promise<Record<'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2', string>> {
    const ids = {
      A1: await send(PARENT_A, 1),
      A2: await send(PARENT_A, 2),
      B1: await send(PARENT_B, 1),
      B2: await send(PARENT_B, 2),
      C1: await send(PARENT_C, 1),
      C2: await send(PARENT_C, 2),
    };
    await makeDue();
    return ids;
  }

  async function stateOf(ids: string[]): Promise<string[]> {
    const rows = await states();
    return ids.map((id) => rows.find((row) => row.id === id)?.state ?? 'missing');
  }

  it('skips a key the peer took and still claims a free parent', async () => {
    const ids = await twoTextsEach();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = peerWins(boss.getDb(), 2, 'unique');

    const result = await fetchSingletonSkippingHeldKeys(port.db, 'pgboss', QUEUE, 1);

    expect(result.jobs.map((job) => job.id)).toEqual([ids.C1]);
    expect(result.claimConflicts).toBe(2);
    expect(await stateOf([ids.A1, ids.B1, ids.C1])).toEqual(['active', 'active', 'active']);
    expect(await stateOf([ids.A2, ids.B2, ids.C2])).toEqual(['created', 'created', 'created']);
    expect(warn).toHaveBeenCalledWith({ queue: QUEUE, claimConflicts: 2 }, CLAIM_LOST);
    warn.mockRestore();
  });

  it('treats an update the peer beat to the row as a lost claim, not an empty queue', async () => {
    const ids = await twoTextsEach();
    const port = peerWins(boss.getDb(), 1, 'forward');

    const result = await fetchSingletonSkippingHeldKeys(port.db, 'pgboss', QUEUE, 1);

    expect(result.jobs.map((job) => job.id)).toEqual([ids.B1]);
    expect(result.claimConflicts).toBe(1);
    expect(await stateOf([ids.A1, ids.B1])).toEqual(['active', 'active']);
  });

  it('claims the oldest free parent and logs nothing when no peer races', async () => {
    const ids = await twoTextsEach();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = peerWins(boss.getDb(), 0, 'unique');

    const result = await fetchSingletonSkippingHeldKeys(port.db, 'pgboss', QUEUE, 1);

    expect(result.jobs.map((job) => job.id)).toEqual([ids.A1]);
    expect(result.claimConflicts).toBe(0);
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), CLAIM_LOST);
    warn.mockRestore();
  });

  it('ends after one lost claim per distinct key when every claim loses', async () => {
    const ids = await twoTextsEach();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const port = peerWins(boss.getDb(), Number.POSITIVE_INFINITY, 'unique');

    const result = await fetchSingletonSkippingHeldKeys(port.db, 'pgboss', QUEUE, 1);

    expect(result.jobs).toEqual([]);
    expect(result.claimConflicts).toBe(3);
    expect(port.intercepted()).toBe(3);
    expect(await stateOf([ids.A1, ids.B1, ids.C1])).toEqual(['active', 'active', 'active']);
    const claimLogs = warn.mock.calls.filter((call) => call[1] === CLAIM_LOST);
    expect(claimLogs).toEqual([[{ queue: QUEUE, claimConflicts: 3 }, CLAIM_LOST]]);
    const logged = JSON.stringify(claimLogs);
    for (const id of Object.values(ids)) expect(logged).not.toContain(id);
    for (const parent of [PARENT_A, PARENT_B, PARENT_C]) expect(logged).not.toContain(parent);
    warn.mockRestore();
  });

  /**
   * No peer at all: every claim raises 23505 (an index that disagrees with the SELECT's
   * NOT EXISTS), so no row ever goes active and NOT EXISTS never skips a key. The only
   * thing that ends the loop is the SELECT's exclusion of keys already lost this fetch.
   * The port counts statements and throws at a ceiling, so a regression fails here
   * instead of hanging the suite.
   */
  it('stays finite under a persistent unique violation with no real peer', async () => {
    const ids = await twoTextsEach();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const raw = boss.getDb();
    const CEILING = 50;
    let statements = 0;
    let claims = 0;
    let lastExcluded: unknown;
    const port: QueueSql = {
      async executeSql(text, values) {
        statements += 1;
        if (statements > CEILING) throw new Error(`claim loop ran past ${CEILING} statements`);
        if (/^select\b/i.test(text.trimStart())) {
          lastExcluded = [...(values[1] as string[])];
          return raw.executeSql(text, values);
        }
        claims += 1;
        throw Object.assign(new Error('duplicate key'), { code: '23505' });
      },
    };

    const result = await fetchSingletonSkippingHeldKeys(port, 'pgboss', QUEUE, 1);

    expect(result.jobs).toEqual([]);
    expect(result.claimConflicts).toBe(3);
    // One SELECT and one lost claim per distinct key, then the SELECT that finds none.
    expect(claims).toBe(3);
    expect(statements).toBe(7);
    expect(lastExcluded).toEqual([PARENT_A, PARENT_B, PARENT_C].map((p) => channelSmsNoteKey(p)));
    expect(await stateOf(Object.values(ids))).toEqual(Object.values(ids).map(() => 'created'));
    expect(warn.mock.calls.filter((call) => call[1] === CLAIM_LOST)).toEqual([
      [{ queue: QUEUE, claimConflicts: 3 }, CLAIM_LOST],
    ]);
    warn.mockRestore();
  });
});
