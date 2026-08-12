import type { ApprovedActionPayload, IngestedEventPayload } from '@hale/tools-contracts';
import { describe, expect, it, vi } from 'vitest';
import { type DrainBoss, type DrainDeps, HOT_QUEUE_EXPIRE_SECONDS, drainHotQueues } from './drain';

/**
 * Drain-loop control flow with a FAKE pg-boss + FAKE orchestrator handlers
 * (rule #8: we fake the QUEUE and the orchestrator function boundary — never the
 * LLM). The orchestrator's own gates/idempotency are covered in apps/worker;
 * here we assert the shell: fetch → run → complete on success, fail on throw,
 * drop schema-invalid, honour the batch + wall-clock budget, drain both queues,
 * and that an at-least-once redelivery of the SAME job is idempotent (the
 * orchestrator's dedup contract is exercised through a stateful fake handler).
 */

const EVENTS = 'events.ingested';
const ACTIONS = 'actions.approved';
const RERANK = 'village.rerank';
const CHANNEL = 'channel.send';
const INBOUND = 'channel.message.received';
const FAMILY = '11111111-1111-1111-1111-111111111111';
const PARENT = '22222222-2222-2222-2222-222222222222';

function validChannelSend() {
  return {
    templateKey: 'weekly-plan-v1',
    familyId: FAMILY,
    parentUserId: PARENT,
    category: 'weekly_plan' as const,
    urgency: 'normal' as const,
    payload: {},
    dedupeKey: 'fam:2026-W23:weekly',
  };
}
const ACTION = '22222222-2222-2222-2222-222222222222';

function validIngested(): IngestedEventPayload {
  return {
    family_id: FAMILY,
    source: 'village',
    payload: { event_type: 'activity_signup_open', candidate_id: 'c1' },
    received_at: new Date().toISOString(),
  };
}

function validApproved(): ApprovedActionPayload {
  return {
    action_id: ACTION,
    family_id: FAMILY,
    approved_by: 'user-1',
    approved_at: new Date().toISOString(),
  };
}

/**
 * A fake pg-boss queue: holds pending jobs per queue, drains them in batches via
 * fetch, and records complete()/fail() calls. createQueue records its options so
 * the test can assert expireInSeconds is set.
 */
type Pending = Array<{ id: string; data: unknown }>;

function makeFakeBoss(initial: Record<string, Pending>) {
  const pending = new Map<string, Pending>([
    [EVENTS, [...(initial[EVENTS] ?? [])]],
    [ACTIONS, [...(initial[ACTIONS] ?? [])]],
    [RERANK, [...(initial[RERANK] ?? [])]],
    [CHANNEL, [...(initial[CHANNEL] ?? [])]],
    [INBOUND, [...(initial[INBOUND] ?? [])]],
  ]);
  const completed = new Map<string, string[]>([
    [EVENTS, []],
    [ACTIONS, []],
    [RERANK, []],
    [CHANNEL, []],
    [INBOUND, []],
  ]);
  const failed = new Map<string, string[]>([
    [EVENTS, []],
    [ACTIONS, []],
    [RERANK, []],
    [CHANNEL, []],
    [INBOUND, []],
  ]);
  const created: Array<{ name: string; expireInSeconds?: number; policy?: string }> = [];

  const fetch = vi.fn(async (name: string, options: { batchSize: number }) => {
    const queue = pending.get(name) ?? [];
    if (name !== INBOUND) return queue.splice(0, options.batchSize);
    // The singleton queue, as pg-boss really behaves: fetchNextJob partitions by
    // singleton_key and activates only the first row per key, so a burst from ONE
    // parent comes back one job at a time however large the batch is. A fake that
    // spliced the whole batch would be more permissive than production and would
    // pass an ordering test the deployed drain fails.
    const taken: Pending = [];
    const keys = new Set<string>();
    for (const job of queue) {
      const key = String((job.data as { parent_user_id?: string }).parent_user_id ?? '');
      if (keys.has(key)) continue;
      keys.add(key);
      taken.push(job);
      if (taken.length >= options.batchSize) break;
    }
    for (const job of taken) queue.splice(queue.indexOf(job), 1);
    return taken;
  });

  const boss = {
    createQueue: vi.fn(
      async (
        name: string,
        options?: { name: string; expireInSeconds?: number; policy?: string },
      ) => {
        created.push({
          name: options?.name ?? name,
          expireInSeconds: options?.expireInSeconds,
          policy: options?.policy,
        });
      },
    ),
    fetch,
    complete: vi.fn(async (name: string, id: string) => {
      completed.get(name)?.push(id);
    }),
    fail: vi.fn(async (name: string, id: string) => {
      failed.get(name)?.push(id);
    }),
  } as unknown as DrainBoss & { fetch: typeof fetch };

  return {
    boss,
    completed: (q: string) => completed.get(q) ?? [],
    failed: (q: string) => failed.get(q) ?? [],
    created,
  };
}

function makeDeps(boss: DrainBoss, overrides: Partial<DrainDeps['handlers']> = {}): DrainDeps {
  return {
    boss,
    handlers: {
      runOrchestrator: vi.fn(async () => undefined),
      executeApprovedAction: vi.fn(async () => undefined),
      rerank: vi.fn(async () => undefined),
      channelSend: vi.fn(async () => undefined),
      channelMessage: vi.fn(async () => undefined),
      ...overrides,
    },
    log: { info: vi.fn(), error: vi.fn() },
    now: () => 0,
  };
}

describe('drainHotQueues', () => {
  it('creates all hot queues with the fast expiry, then drains them', async () => {
    const { boss, created } = makeFakeBoss({});
    await drainHotQueues(makeDeps(boss));

    expect(created).toContainEqual({ name: EVENTS, expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS });
    expect(created).toContainEqual({ name: ACTIONS, expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS });
    expect(created).toContainEqual({ name: RERANK, expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS });
    expect(HOT_QUEUE_EXPIRE_SECONDS).toBe(180);
  });

  /**
   * A parent waiting on a reply is the only consumer sitting in front of a phone, so
   * their turn goes first. It also has to precede `actions.approved`: a texted "YES"
   * enqueues the approval FROM inside the turn, and draining approvals first means the
   * calendar write it authorises waits for the next tick.
   */
  it('drains the outbound send queue first, then the inbound turn queue ahead of the ranker and the approvals', async () => {
    const { boss } = makeFakeBoss({});
    await drainHotQueues(makeDeps(boss));

    const order = (boss.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([name]) => name);
    expect(order).toEqual([CHANNEL, INBOUND, EVENTS, ACTIONS, RERANK]);
  });

  /**
   * G7 — starvation. `channel.send` carries messages Hale has already decided to send:
   * the weekly brief and the reminders. It used to drain LAST, behind two LLM-bound
   * queues sharing one deadline, so an inference backlog withheld an already-composed
   * message for the whole tick with nothing in the summary saying so.
   */
  it('still delivers the outbound send when an LLM-bound queue eats the whole tick budget', async () => {
    const channelSend = vi.fn(async () => undefined);
    const { boss, completed } = makeFakeBoss({
      [CHANNEL]: [{ id: 'c1', data: validChannelSend() }],
      [INBOUND]: [
        {
          id: 'i1',
          data: {
            family_id: FAMILY,
            parent_user_id: PARENT,
            channel_message_id: '33333333-3333-4333-8333-333333333333',
            provider_message_id: 'SM1',
            received_at: new Date().toISOString(),
          },
        },
      ],
    });

    let clock = 0;
    const deps: DrainDeps = {
      ...makeDeps(boss, {
        // One backed-up inference turn burns the entire wall-clock budget.
        channelMessage: vi.fn(async () => {
          clock += 800_000;
        }),
        channelSend,
      }),
      now: () => clock,
    };

    await drainHotQueues(deps);

    expect(channelSend).toHaveBeenCalledTimes(1);
    expect(completed(CHANNEL)).toEqual(['c1']);
  });

  /**
   * The other half of the same invariant: the send queue gets a SLICE, not the tick.
   * A backlog of sends must not become the new thing that starves the parent whose
   * text is waiting — so its budget runs out and the inbound queue still gets fetched.
   */
  it('bounds the send queue to its own budget slice so it cannot starve the inbound turn', async () => {
    const { boss } = makeFakeBoss({});
    let clock = 0;
    // A send queue that never empties, each job costing a tenth of the tick.
    (boss.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) =>
      name === CHANNEL ? [{ id: `c${clock}`, data: validChannelSend() }] : [],
    );
    const deps: DrainDeps = {
      ...makeDeps(boss, {
        channelSend: vi.fn(async () => {
          clock += 70_000;
        }),
      }),
      now: () => clock,
    };

    await drainHotQueues(deps);

    const fetched = (boss.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([name]) => name);
    expect(fetched).toContain(INBOUND);
    // And the slice really is a slice: it gave up well before the 700s tick budget.
    expect(clock).toBeLessThan(700_000);
  });

  it('materializes the feed rank for a pending village.rerank job and completes it', async () => {
    const { boss, completed, failed } = makeFakeBoss({
      [RERANK]: [{ id: 'r1', data: { family_id: FAMILY } }],
    });
    const deps = makeDeps(boss);

    const summary = await drainHotQueues(deps);

    expect(deps.handlers.rerank).toHaveBeenCalledTimes(1);
    expect(deps.handlers.rerank).toHaveBeenCalledWith(FAMILY);
    expect(completed(RERANK)).toEqual(['r1']);
    expect(failed(RERANK)).toEqual([]);
    expect(summary.processed).toBe(1);
  });

  it('DROPS a schema-invalid village.rerank payload (never calls the ranker)', async () => {
    const { boss, completed, failed } = makeFakeBoss({
      [RERANK]: [{ id: 'bad', data: { family_id: 'not-a-uuid' } }],
    });
    const deps = makeDeps(boss);

    const summary = await drainHotQueues(deps);

    expect(deps.handlers.rerank).not.toHaveBeenCalled();
    expect(completed(RERANK)).toEqual(['bad']);
    expect(failed(RERANK)).toEqual([]);
    expect(summary.dropped).toBe(1);
  });

  it('dispatches a pending channel.send job through the loop seam and completes it', async () => {
    const { boss, completed } = makeFakeBoss({
      [CHANNEL]: [{ id: 'c1', data: validChannelSend() }],
    });
    const deps = makeDeps(boss);

    const summary = await drainHotQueues(deps);

    expect(deps.handlers.channelSend).toHaveBeenCalledTimes(1);
    expect(deps.handlers.channelSend).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'weekly_plan', parentUserId: PARENT }),
    );
    expect(completed(CHANNEL)).toEqual(['c1']);
    expect(summary.processed).toBe(1);
  });

  it('DROPS a schema-invalid channel.send payload (never reaches the seam)', async () => {
    const { boss, completed } = makeFakeBoss({
      [CHANNEL]: [{ id: 'bad', data: { ...validChannelSend(), category: 'not_a_category' } }],
    });
    const deps = makeDeps(boss);

    const summary = await drainHotQueues(deps);

    expect(deps.handlers.channelSend).not.toHaveBeenCalled();
    expect(completed(CHANNEL)).toEqual(['bad']);
    expect(summary.dropped).toBe(1);
  });

  it('re-queues a channel.send job whose handler throws (transient) — never drops it', async () => {
    const { boss, completed, failed } = makeFakeBoss({
      [CHANNEL]: [{ id: 'c2', data: validChannelSend() }],
    });
    const deps = makeDeps(boss, {
      channelSend: vi.fn(async () => {
        throw new Error('transient channel error');
      }),
    });

    await drainHotQueues(deps);

    expect(failed(CHANNEL)).toEqual(['c2']); // boss.fail → redelivery, not completed
    expect(completed(CHANNEL)).toEqual([]);
  });

  it('runs the orchestrator for a pending events.ingested job and completes it', async () => {
    const { boss, completed, failed } = makeFakeBoss({
      [EVENTS]: [{ id: 'e1', data: validIngested() }],
    });
    const deps = makeDeps(boss);

    const summary = await drainHotQueues(deps);

    expect(deps.handlers.runOrchestrator).toHaveBeenCalledTimes(1);
    expect(deps.handlers.runOrchestrator).toHaveBeenCalledWith(
      expect.objectContaining({ family_id: FAMILY, source: 'village' }),
    );
    expect(completed(EVENTS)).toEqual(['e1']);
    expect(failed(EVENTS)).toEqual([]);
    expect(summary).toEqual({ processed: 1, failed: 0, dropped: 0 });
  });

  it('drives an actions.approved job into execution and completes it', async () => {
    const { boss, completed } = makeFakeBoss({
      [ACTIONS]: [{ id: 'a1', data: validApproved() }],
    });
    const deps = makeDeps(boss);

    const summary = await drainHotQueues(deps);

    expect(deps.handlers.executeApprovedAction).toHaveBeenCalledWith({
      actionId: ACTION,
      familyId: FAMILY,
      approvedBy: 'user-1',
    });
    expect(completed(ACTIONS)).toEqual(['a1']);
    expect(summary.processed).toBe(1);
  });

  it('FAILS (does not complete) a job whose handler throws', async () => {
    const { boss, completed, failed } = makeFakeBoss({
      [EVENTS]: [{ id: 'e1', data: validIngested() }],
    });
    const deps = makeDeps(boss, {
      runOrchestrator: vi.fn(async () => {
        throw new Error('orchestrator blew up');
      }),
    });

    const summary = await drainHotQueues(deps);

    expect(failed(EVENTS)).toEqual(['e1']);
    expect(completed(EVENTS)).toEqual([]);
    expect(summary).toEqual({ processed: 0, failed: 1, dropped: 0 });
  });

  it('DROPS (completes, does not fail, does not throw) a schema-invalid payload', async () => {
    const { boss, completed, failed } = makeFakeBoss({
      [EVENTS]: [{ id: 'bad', data: { not: 'a valid payload' } }],
      [ACTIONS]: [{ id: 'bad2', data: { action_id: 'not-a-uuid' } }],
    });
    const deps = makeDeps(boss);

    const summary = await drainHotQueues(deps);

    expect(deps.handlers.runOrchestrator).not.toHaveBeenCalled();
    expect(deps.handlers.executeApprovedAction).not.toHaveBeenCalled();
    expect(completed(EVENTS)).toEqual(['bad']);
    expect(completed(ACTIONS)).toEqual(['bad2']);
    expect(failed(EVENTS)).toEqual([]);
    expect(summary).toEqual({ processed: 0, failed: 0, dropped: 2 });
  });

  it('stops fetching once the wall-clock budget is exhausted (does not loop forever)', async () => {
    // A full batch every fetch would loop forever without the time budget; the
    // clock jumps past the deadline after the first batch, so exactly one fetch
    // per queue runs.
    const fullBatch = Array.from({ length: 10 }, (_, i) => ({
      id: `e${i}`,
      data: validIngested(),
    }));
    const { boss } = makeFakeBoss({ [EVENTS]: [...fullBatch] });
    // Keep refilling events so that queue never empties on its own.
    (boss.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) =>
      name === EVENTS ? fullBatch.map((j) => ({ ...j })) : [],
    );

    // now() call 0 seeds the deadlines (= 0 + budget); calls 1 and 2 are the send and
    // inbound queues' while checks (both fetch nothing and return); call 3 is the events
    // queue's first check, under the deadline → one batch is fetched + processed; call 4
    // jumps past the deadline → the loop stops, and every later queue's first check is
    // past it too, so nothing else is fetched.
    let calls = 0;
    const deps: DrainDeps = {
      ...makeDeps(boss),
      now: () => (calls++ < 4 ? 0 : 1_000_000_000),
    };

    const summary = await drainHotQueues(deps);

    expect(boss.fetch).toHaveBeenCalledTimes(3);
    expect(boss.fetch).toHaveBeenNthCalledWith(3, EVENTS, { batchSize: 10 });
    expect(summary.processed).toBe(10);
  });

  it('is idempotent on at-least-once redelivery: the same job id does not double-create', async () => {
    // Model the orchestrator's real dedup contract: recordEvent uses
    // onConflictDoNothing on (family_id, dedup_hash), so a re-run of the SAME
    // payload is a no-op downstream. We assert the drain re-delivers and the
    // stateful handler creates exactly one draft for two deliveries of one job.
    const drafts = new Set<string>();
    const stateful = vi.fn(async (job: IngestedEventPayload) => {
      const dedupKey = `${job.family_id}:${JSON.stringify(job.payload)}`;
      if (drafts.has(dedupKey)) return; // duplicate event → skip downstream
      drafts.add(dedupKey);
    });

    const payload = validIngested();
    // Same job redelivered (e.g. expiry requeued it after a crash-before-complete).
    const { boss } = makeFakeBoss({
      [EVENTS]: [
        { id: 'job-x', data: payload },
        { id: 'job-x', data: payload },
      ],
    });
    const deps = makeDeps(boss, { runOrchestrator: stateful });

    const summary = await drainHotQueues(deps);

    expect(stateful).toHaveBeenCalledTimes(2);
    expect(drafts.size).toBe(1);
    expect(summary.processed).toBe(2);
  });
});

/**
 * VIL-220 · C1 — the inbound-router queue. Two properties are asserted here and
 * nowhere else: that this queue is created under the SINGLETON policy (without it
 * pg-boss records the singleton key and enforces nothing, so per-conversation FIFO
 * silently degrades to "whatever order the batch came back in"), and that the drain
 * loop runs the jobs it fetched ONE AT A TIME in fetch order.
 */
describe('channel.message.received', () => {
  function inbound(providerId: string) {
    return {
      family_id: FAMILY,
      parent_user_id: PARENT,
      channel_message_id: '33333333-3333-4333-8333-333333333333',
      provider_message_id: providerId,
      received_at: new Date().toISOString(),
    };
  }

  it('creates the queue under the singleton policy that enforces the key', async () => {
    const { boss, created } = makeFakeBoss({});
    await drainHotQueues(makeDeps(boss));

    expect(created).toContainEqual({
      name: INBOUND,
      expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
      policy: 'singleton',
    });
  });

  it('routes a pending inbound job and completes it', async () => {
    const { boss, completed } = makeFakeBoss({
      [INBOUND]: [{ id: 'i1', data: inbound('SM1') }],
    });
    const deps = makeDeps(boss);

    const summary = await drainHotQueues(deps);

    expect(deps.handlers.channelMessage).toHaveBeenCalledTimes(1);
    expect(deps.handlers.channelMessage).toHaveBeenCalledWith(
      expect.objectContaining({ provider_message_id: 'SM1', parent_user_id: PARENT }),
    );
    expect(completed(INBOUND)).toEqual(['i1']);
    expect(summary.processed).toBe(1);
  });

  /**
   * Two texts a second apart. They must be ROUTED in the order they were sent and
   * never concurrently: "move swim to Tuesday" then "actually Wednesday" produces the
   * wrong week if the second is applied first, and two overlapping turns would each
   * read a thread that is missing the other's message.
   */
  it('processes two texts from one parent strictly in order, one at a time', async () => {
    const seen: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const { boss } = makeFakeBoss({
      [INBOUND]: [
        { id: 'i1', data: inbound('SM1') },
        { id: 'i2', data: inbound('SM2') },
      ],
    });
    const deps = makeDeps(boss, {
      channelMessage: vi.fn(async (job: { provider_message_id: string }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        seen.push(job.provider_message_id);
        await new Promise((resolve) => setImmediate(resolve));
        inFlight -= 1;
      }),
    });

    await drainHotQueues(deps);

    expect(seen).toEqual(['SM1', 'SM2']);
    expect(maxInFlight).toBe(1);
  });

  it('DROPS a schema-invalid inbound payload (never reaches the router)', async () => {
    const { boss, completed } = makeFakeBoss({
      [INBOUND]: [{ id: 'bad', data: { ...inbound('SM1'), family_id: 'not-a-uuid' } }],
    });
    const deps = makeDeps(boss);

    const summary = await drainHotQueues(deps);

    expect(deps.handlers.channelMessage).not.toHaveBeenCalled();
    expect(completed(INBOUND)).toEqual(['bad']);
    expect(summary.dropped).toBe(1);
  });

  it('re-queues an inbound job whose routing throws — a parent is never dropped silently', async () => {
    const { boss, completed, failed } = makeFakeBoss({
      [INBOUND]: [{ id: 'i3', data: inbound('SM3') }],
    });
    const deps = makeDeps(boss, {
      channelMessage: vi.fn(async () => {
        throw new Error('transient db error');
      }),
    });

    const summary = await drainHotQueues(deps);

    expect(failed(INBOUND)).toEqual(['i3']);
    expect(completed(INBOUND)).toEqual([]);
    expect(summary.failed).toBe(1);
  });
});
