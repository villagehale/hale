import type { ApprovedActionPayload, IngestedEventPayload } from '@hale/tools-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  DEEP_RESEARCH_BATCH_SIZE,
  DEEP_RESEARCH_BUDGET_MS,
  DEEP_RESEARCH_EXPIRE_SECONDS,
  DEEP_RESEARCH_QUEUE,
} from '~/lib/channel/activity/deep-queue';
import {
  CHANNEL_MESSAGE_RECEIVED_RETRY,
  TURN_EXPIRED_UNANSWERED,
} from '~/lib/channel/config';
import {
  DRAINABLE_QUEUES,
  type DrainBoss,
  type DrainDeps,
  HOT_QUEUE_EXPIRE_SECONDS,
  INBOUND_TURN_QUEUES,
  drainHotQueues,
  isConnectionExhaustion,
} from './drain';

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
const DEEP = DEEP_RESEARCH_QUEUE;
const CHANNEL = 'channel.send';
const INBOUND = 'channel.message.received';
const DEAD = 'channel.message.received.dead';
// The queue-policy invariant (audit P0-3): every work queue dead-letters somewhere
// CONSUMED. Literals, not imports — these are data values in production's queue table.
const CHANNEL_DEAD = 'channel.send.dead';
const EVENTS_DEAD = 'events.ingested.dead';
const ACTIONS_DEAD = 'actions.approved.dead';
const RERANK_DEAD = 'village.rerank.dead';
const DEEP_DEAD = 'deep.research.dead';
const WORK_QUEUES = [EVENTS, ACTIONS, RERANK, CHANNEL, INBOUND, DEEP] as const;
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

/** Every option a queue was declared with, so the retry ceiling and the dead-letter
 * target are assertable and not just the two A3 shipped. */
type QueueCall = {
  name: string;
  expireInSeconds?: number;
  policy?: string;
  retryLimit?: number;
  retryDelay?: number;
  retryBackoff?: boolean;
  deadLetter?: string;
};

const ALL_QUEUES = [
  EVENTS,
  ACTIONS,
  RERANK,
  CHANNEL,
  INBOUND,
  DEAD,
  DEEP,
  CHANNEL_DEAD,
  EVENTS_DEAD,
  ACTIONS_DEAD,
  RERANK_DEAD,
  DEEP_DEAD,
] as const;

function makeFakeBoss(initial: Record<string, Pending>) {
  const pending = new Map<string, Pending>(ALL_QUEUES.map((q) => [q, [...(initial[q] ?? [])]]));
  const completed = new Map<string, string[]>(ALL_QUEUES.map((q) => [q, []]));
  const failed = new Map<string, string[]>(ALL_QUEUES.map((q) => [q, []]));
  const created: QueueCall[] = [];
  const updated: QueueCall[] = [];

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
    createQueue: vi.fn(async (name: string, options?: Omit<QueueCall, 'name'> & { name?: string }) => {
      created.push({ ...options, name: options?.name ?? name });
    }),
    updateQueue: vi.fn(async (name: string, options?: Omit<QueueCall, 'name'> & { name?: string }) => {
      updated.push({ ...options, name: options?.name ?? name });
    }),
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
    updated,
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
      channelSendDead: vi.fn(async () => undefined),
      channelMessage: vi.fn(async () => undefined),
      deepResearch: vi.fn(async () => undefined),
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

    expect(created).toContainEqual(
      expect.objectContaining({ name: EVENTS, expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS }),
    );
    expect(created).toContainEqual(
      expect.objectContaining({ name: ACTIONS, expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS }),
    );
    expect(created).toContainEqual(
      expect.objectContaining({ name: RERANK, expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS }),
    );
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
    expect(order).toEqual([
      CHANNEL,
      CHANNEL_DEAD,
      INBOUND,
      DEAD,
      EVENTS,
      EVENTS_DEAD,
      ACTIONS,
      ACTIONS_DEAD,
      RERANK,
      RERANK_DEAD,
      DEEP_DEAD,
      DEEP,
    ]);
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

    // now() call 0 seeds the deadlines (= 0 + budget); calls 1-4 are the send queue, its
    // dead letter, the inbound queue and ITS dead letter's while checks (all fetch
    // nothing and return); call 5 is the events queue's first check, under the deadline
    // → one batch is fetched + processed; call 6 jumps past the deadline → the loop
    // stops, and every later queue's first check is past it too, so nothing else is
    // fetched.
    let calls = 0;
    const deps: DrainDeps = {
      ...makeDeps(boss),
      now: () => (calls++ < 6 ? 0 : 1_000_000_000),
    };

    const summary = await drainHotQueues(deps);

    expect(boss.fetch).toHaveBeenCalledTimes(5);
    expect(boss.fetch).toHaveBeenNthCalledWith(5, EVENTS, { batchSize: 10 });
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

    expect(created).toContainEqual(
      expect.objectContaining({
        name: INBOUND,
        expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
        policy: 'singleton',
      }),
    );
  });

  /**
   * The defer arc's ceiling. The router throws an unreachable-model turn back HERE so
   * the job fails rather than completes, which only becomes a wait for the model rather
   * than a lost text if the queue carries a real retry policy — pg-boss's default is two
   * attempts with no delay between them.
   */
  it('creates the queue with the defer arc\'s retry ceiling and its dead letter', async () => {
    const { boss, created } = makeFakeBoss({});
    await drainHotQueues(makeDeps(boss));

    expect(created).toContainEqual(
      expect.objectContaining({
        name: INBOUND,
        ...CHANNEL_MESSAGE_RECEIVED_RETRY,
        deadLetter: DEAD,
      }),
    );
  });

  /** `job.dead_letter` is a foreign key onto `queue(name)`, so the order is the
   * difference between a working queue and a constraint violation on first use. */
  it('creates the dead-letter queue before the queue that points at it', async () => {
    const { boss, created } = makeFakeBoss({});
    await drainHotQueues(makeDeps(boss));

    const names = created.map((c) => c.name);
    expect(names.indexOf(DEAD)).toBeGreaterThanOrEqual(0);
    expect(names.indexOf(DEAD)).toBeLessThan(names.indexOf(INBOUND));
  });

  /**
   * A turn that spent every retry. The parent is NEVER answered — the founder's chosen
   * trade, because a "sorry" two hours after the question is worse than silence — but
   * the abandonment is a named, counted outcome rather than a job that quietly stops
   * existing (rule #11).
   */
  it('names an expired turn on the log and sends nothing', async () => {
    const channelMessage = vi.fn(async () => undefined);
    const { boss, completed } = makeFakeBoss({
      [DEAD]: [{ id: 'd1', data: inbound('SM9') }],
    });
    const deps = makeDeps(boss, { channelMessage });

    const summary = await drainHotQueues(deps);

    expect(channelMessage).not.toHaveBeenCalled();
    expect(completed(DEAD)).toEqual(['d1']);
    expect(summary.dropped).toBe(1);
    expect(deps.log.error).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: TURN_EXPIRED_UNANSWERED,
        channelMessageId: inbound('SM9').channel_message_id,
      }),
      expect.stringContaining('never answered'),
    );
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

/**
 * THE SLICE — what makes a kicked drain a hot path rather than a whole tick.
 *
 * A parent's text used to be picked up by a run that drained `channel.send` first under
 * a two-minute budget, so their question waited behind briefs and reminders that had
 * nothing to do with them. The inbound kick now asks for its own queue and only its own
 * queue; the cron keeps asking for everything.
 */
describe('drainHotQueues — queue slice', () => {
  it('fetches only the named queue when a slice is given', async () => {
    const { boss } = makeFakeBoss({});

    await drainHotQueues(makeDeps(boss), { queues: INBOUND_TURN_QUEUES });

    const fetched = (boss.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([name]) => name);
    expect(fetched).toEqual([INBOUND]);
  });

  /**
   * The point of the slice, stated as the failure it prevents: a send queue that never
   * empties owns the first 120s of every full run, and the parent's turn is behind it.
   * Under the inbound slice that queue is not even fetched, so the turn runs at once.
   */
  it('answers the inbound turn immediately even while the send queue is saturated', async () => {
    const { boss } = makeFakeBoss({});
    let clock = 0;
    (boss.fetch as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
      if (name === CHANNEL) return [{ id: `c${clock}`, data: validChannelSend() }];
      if (name === INBOUND) {
        return [
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
        ];
      }
      return [];
    });
    const pickedUpAt: number[] = [];
    const deps: DrainDeps = {
      ...makeDeps(boss, {
        channelSend: vi.fn(async () => {
          clock += 10_000;
        }),
        channelMessage: vi.fn(async () => {
          pickedUpAt.push(clock);
          clock += 700_000;
        }),
      }),
      now: () => clock,
    };

    await drainHotQueues(deps, { queues: INBOUND_TURN_QUEUES });

    expect(pickedUpAt[0]).toBe(0);
  });

  /** Every queue still gets DECLARED — the dead-letter target is a foreign key onto the
   * queue table, so a partial declaration is how the inbound queue fails to exist. */
  it('declares every queue even when draining one', async () => {
    const { boss, created } = makeFakeBoss({});

    await drainHotQueues(makeDeps(boss), { queues: INBOUND_TURN_QUEUES });

    expect(created.map((call) => call.name)).toEqual(expect.arrayContaining([...ALL_QUEUES]));
  });

  it('drains every queue when no slice is given', async () => {
    const { boss } = makeFakeBoss({});

    await drainHotQueues(makeDeps(boss));

    const fetched = (boss.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([name]) => name);
    expect(fetched).toEqual(DRAINABLE_QUEUES);
  });

  /** The route validates a caller's slice against this list, so a name that is not a real
   * queue is a 400 rather than a run that drains nothing and reports success. */
  it('names the inbound queue in the drainable set', () => {
    expect(DRAINABLE_QUEUES).toContain(INBOUND);
    expect(INBOUND_TURN_QUEUES).toEqual([INBOUND]);
  });
});

/**
 * The one failure the kicker must be able to tell apart from every other 5xx: the
 * database refused the connection. A retry then is a second invocation asking for a
 * connection that is not there, so this predicate is what turns the drain's answer into
 * a 503 and the kicker's retry into a back-off (app/api/cron/drain/route.ts).
 */
describe('isConnectionExhaustion', () => {
  it('recognises the exhaustion Postgres and the pooler actually report', () => {
    expect(
      isConnectionExhaustion(
        Object.assign(new Error('sorry, too many clients already'), { code: '53300' }),
      ),
    ).toBe(true);
    // The direct port answers with the message and no code on some driver paths.
    expect(isConnectionExhaustion(new Error('sorry, too many clients already'))).toBe(true);
    // Supabase's pooler says it differently.
    expect(isConnectionExhaustion(new Error('max clients reached'))).toBe(true);
  });

  it('does not swallow the failures that are NOT exhaustion', () => {
    // A drain that threw for any other reason must keep 500ing — a 503 would tell every
    // kicker to stop kicking over a bug in one handler.
    expect(isConnectionExhaustion(new Error('relation "pgboss.job" does not exist'))).toBe(false);
    expect(isConnectionExhaustion(Object.assign(new Error('deadlock'), { code: '40P01' }))).toBe(
      false,
    );
    expect(isConnectionExhaustion(null)).toBe(false);
    expect(isConnectionExhaustion('too many clients already')).toBe(false);
  });
});

/**
 * THE QUESTION-TIME DEEP PASS on the drain — the one queue whose jobs are measured in
 * minutes rather than in seconds.
 *
 * Every property here is about that difference. It is drained LAST so it cannot delay a
 * parent's text; it is fetched ONE AT A TIME so the wall-clock deadline is honoured
 * between jobs rather than only between batches; and its queue is declared with its own
 * expiry, because the hot 180 seconds would have pg-boss reclaim a job that is still
 * working and pay for the whole run twice.
 */
describe('deep.research', () => {
  const COMMITMENT = '55555555-5555-4555-8555-555555555555';

  function validDeep() {
    return { commitment_id: COMMITMENT, family_id: FAMILY };
  }

  it('declares the queue with its OWN expiry, not the hot one', async () => {
    const { boss, created } = makeFakeBoss({});
    await drainHotQueues(makeDeps(boss));

    const declared = created.find((call) => call.name === DEEP);
    expect(declared?.expireInSeconds).toBe(DEEP_RESEARCH_EXPIRE_SECONDS);
    expect(declared?.expireInSeconds).toBeGreaterThan(HOT_QUEUE_EXPIRE_SECONDS);
  });

  it('is drainable by name and runs the handler, then completes the job', async () => {
    const deepResearch = vi.fn(async () => undefined);
    const { boss, completed } = makeFakeBoss({ [DEEP]: [{ id: 'd1', data: validDeep() }] });

    await drainHotQueues(makeDeps(boss, { deepResearch }));

    expect(DRAINABLE_QUEUES).toContain(DEEP);
    expect(deepResearch).toHaveBeenCalledWith(validDeep());
    expect(completed(DEEP)).toEqual(['d1']);
  });

  it('fetches ONE job at a time, so the deadline is checked between minutes-long runs', async () => {
    const { boss } = makeFakeBoss({});
    await drainHotQueues(makeDeps(boss));

    const deepFetch = (boss.fetch as ReturnType<typeof vi.fn>).mock.calls.find(
      ([name]) => name === DEEP,
    );
    expect(deepFetch?.[1]).toEqual({ batchSize: DEEP_RESEARCH_BATCH_SIZE });
    expect(DEEP_RESEARCH_BATCH_SIZE).toBe(1);
  });

  it('does not START a deep job once the run is past its slice', async () => {
    const deepResearch = vi.fn(async () => undefined);
    const { boss } = makeFakeBoss({ [DEEP]: [{ id: 'd1', data: validDeep() }] });
    const deps = makeDeps(boss, { deepResearch });
    // The run STARTS at zero and the clock has moved past the slice by the time the deep
    // step is reached - which is the real shape, since the slice is measured from the
    // start of the tick and this queue is drained last.
    let first = true;
    deps.now = () => {
      if (first) {
        first = false;
        return 0;
      }
      return DEEP_RESEARCH_BUDGET_MS + 1;
    };

    await drainHotQueues(deps);

    expect(deepResearch).not.toHaveBeenCalled();
  });

  it('DROPS a schema-invalid payload (never reaches the lane)', async () => {
    const deepResearch = vi.fn(async () => undefined);
    const { boss, completed, failed } = makeFakeBoss({
      [DEEP]: [{ id: 'd1', data: { commitment_id: 'not-a-uuid' } }],
    });

    const summary = await drainHotQueues(makeDeps(boss, { deepResearch }));

    expect(deepResearch).not.toHaveBeenCalled();
    expect(summary.dropped).toBe(1);
    expect(completed(DEEP)).toEqual(['d1']);
    expect(failed(DEEP)).toEqual([]);
  });

  it('re-queues a deep job whose handler throws - the promise is never silently lost', async () => {
    const deepResearch = vi.fn(async () => {
      throw new Error('provider down');
    });
    const { boss, completed, failed } = makeFakeBoss({ [DEEP]: [{ id: 'd1', data: validDeep() }] });

    const summary = await drainHotQueues(makeDeps(boss, { deepResearch }));

    expect(failed(DEEP)).toEqual(['d1']);
    expect(completed(DEEP)).toEqual([]);
    expect(summary.failed).toBe(1);
  });
});

/**
 * THE QUEUE-POLICY INVARIANT (SMS reliability audit P0-3). `channel.send` rode pg-boss's
 * defaults — two retries zero seconds apart, no dead letter — so a transient Twilio blip
 * during a weekly-brief burst burned all three attempts inside the same blip and the
 * composed message stopped existing with no ledger row and no trace. The inbound turn
 * queue was cured of exactly this class (retryLimit 8 + backoff + a consumed DLQ); these
 * tests pin that NO work queue can ride defaults again.
 */
describe('every work queue declares an explicit retry policy and a dead letter', () => {
  it('declares retryLimit, retryDelay, retryBackoff and deadLetter on every work queue', async () => {
    const { boss, created } = makeFakeBoss({});
    await drainHotQueues(makeDeps(boss));

    for (const queue of WORK_QUEUES) {
      const call = created.find((c) => c.name === queue);
      expect(call, `${queue} was never declared`).toBeTruthy();
      expect(call?.retryLimit, `${queue} rides the default retry limit`).toBeGreaterThan(0);
      expect(call?.retryDelay, `${queue} rides the default zero retry delay`).toBeGreaterThan(0);
      expect(call?.retryBackoff, `${queue} retries with no backoff`).toBe(true);
      expect(call?.deadLetter, `${queue} has nowhere to dead-letter`).toMatch(/\.dead$/);
    }
  });

  /** The cure, applied: the same arc the inbound turn queue survives outages on —
   * roughly one to two hours of backoff with the first attempts inside the first
   * minutes, which is where provider blips overwhelmingly end. */
  it("gives channel.send the inbound cure's retry arc and its own dead letter", async () => {
    const { boss, created } = makeFakeBoss({});
    await drainHotQueues(makeDeps(boss));

    expect(created).toContainEqual(
      expect.objectContaining({
        name: CHANNEL,
        retryLimit: 8,
        retryDelay: 15,
        retryBackoff: true,
        deadLetter: CHANNEL_DEAD,
      }),
    );
    // "Matching the inbound cure" is a relation, not a coincidence of two literals.
    expect(CHANNEL_MESSAGE_RECEIVED_RETRY).toEqual({
      retryLimit: 8,
      retryDelay: 15,
      retryBackoff: true,
    });
  });

  /** pg-boss's `dead_letter` is a foreign key onto `queue(name)` — every pair, not just
   * the inbound one, must land dead-letter-first. */
  it('creates every dead letter before the queue that names it', async () => {
    const { boss, created } = makeFakeBoss({});
    await drainHotQueues(makeDeps(boss));

    const names = created.map((c) => c.name);
    for (const queue of WORK_QUEUES) {
      const dlq = created.find((c) => c.name === queue)?.deadLetter;
      expect(dlq, `${queue} has no dead letter`).toBeTruthy();
      expect(names.indexOf(String(dlq)), `${dlq} created after ${queue}`).toBeLessThan(
        names.indexOf(queue),
      );
    }
  });

  /** The landmine the inbound queue already stepped on: create_queue ends in ON
   * CONFLICT DO NOTHING, so production queues that already exist keep pg-boss defaults
   * unless updateQueue converges them with the SAME options. */
  it('CONVERGES every existing work queue: updateQueue mirrors createQueue', async () => {
    const { boss, created, updated } = makeFakeBoss({});
    await drainHotQueues(makeDeps(boss));

    for (const queue of WORK_QUEUES) {
      const declared = created.find((c) => c.name === queue);
      expect(updated, `${queue} is never converged`).toContainEqual(declared);
    }
  });
});

/**
 * The consumed half of the invariant for the queue P0-3 was about: a `channel.send` job
 * that spent every retry is handed to the ledger writer, so the abandonment is a
 * `failed` channel_messages row (rule #11) — never a log-only grave, never a job that
 * quietly stops existing.
 */
describe('channel.send.dead', () => {
  it('hands a dead send to the channelSendDead handler and counts it dropped', async () => {
    const channelSendDead = vi.fn(async () => undefined);
    const { boss, completed } = makeFakeBoss({
      [CHANNEL_DEAD]: [{ id: 'x1', data: validChannelSend() }],
    });

    const summary = await drainHotQueues(makeDeps(boss, { channelSendDead }));

    expect(channelSendDead).toHaveBeenCalledWith(
      expect.objectContaining({ templateKey: 'weekly-plan-v1', familyId: FAMILY }),
    );
    expect(completed(CHANNEL_DEAD)).toEqual(['x1']);
    expect(summary.dropped).toBe(1);
  });

  it('DROPS a schema-invalid dead payload without calling the handler', async () => {
    const channelSendDead = vi.fn(async () => undefined);
    const { boss, completed } = makeFakeBoss({
      [CHANNEL_DEAD]: [{ id: 'bad', data: { not: 'a send' } }],
    });

    const summary = await drainHotQueues(makeDeps(boss, { channelSendDead }));

    expect(channelSendDead).not.toHaveBeenCalled();
    expect(completed(CHANNEL_DEAD)).toEqual(['bad']);
    expect(summary.dropped).toBe(1);
  });

  it('re-queues when the ledger write itself throws — the abandonment row is never silently lost', async () => {
    const channelSendDead = vi.fn(async () => {
      throw new Error('db down');
    });
    const { boss, failed } = makeFakeBoss({
      [CHANNEL_DEAD]: [{ id: 'x1', data: validChannelSend() }],
    });

    const summary = await drainHotQueues(makeDeps(boss, { channelSendDead }));

    expect(failed(CHANNEL_DEAD)).toEqual(['x1']);
    expect(summary.failed).toBe(1);
  });
});
