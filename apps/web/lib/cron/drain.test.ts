import { describe, expect, it, vi } from 'vitest';
import type { ApprovedActionPayload, IngestedEventPayload } from '@hale/tools-contracts';
import {
  type DrainBoss,
  type DrainDeps,
  HOT_QUEUE_EXPIRE_SECONDS,
  drainHotQueues,
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
const FAMILY = '11111111-1111-1111-1111-111111111111';
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
  ]);
  const completed = new Map<string, string[]>([
    [EVENTS, []],
    [ACTIONS, []],
  ]);
  const failed = new Map<string, string[]>([
    [EVENTS, []],
    [ACTIONS, []],
  ]);
  const created: Array<{ name: string; expireInSeconds?: number }> = [];

  const fetch = vi.fn(async (name: string, options: { batchSize: number }) => {
    const queue = pending.get(name) ?? [];
    return queue.splice(0, options.batchSize);
  });

  const boss = {
    createQueue: vi.fn(async (name: string, options?: { name: string; expireInSeconds?: number }) => {
      created.push({ name: options?.name ?? name, expireInSeconds: options?.expireInSeconds });
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
  };
}

function makeDeps(boss: DrainBoss, overrides: Partial<DrainDeps['handlers']> = {}): DrainDeps {
  return {
    boss,
    handlers: {
      runOrchestrator: vi.fn(async () => undefined),
      executeApprovedAction: vi.fn(async () => undefined),
      ...overrides,
    },
    log: { info: vi.fn(), error: vi.fn() },
    now: () => 0,
  };
}

describe('drainHotQueues', () => {
  it('creates both queues with the fast expiry, then drains them', async () => {
    const { boss, created } = makeFakeBoss({});
    await drainHotQueues(makeDeps(boss));

    expect(created).toContainEqual({ name: EVENTS, expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS });
    expect(created).toContainEqual({ name: ACTIONS, expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS });
    expect(HOT_QUEUE_EXPIRE_SECONDS).toBe(180);
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
    // Keep refilling so the queue never empties on its own.
    (boss.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () =>
      fullBatch.map((j) => ({ ...j })),
    );

    // now() call 0 seeds the deadline (= 0 + budget); call 1 (first while check)
    // is under it → one batch is fetched + processed; call 2 (next while check)
    // jumps past the deadline → the loop stops. The actions queue's first while
    // check is then also past the deadline → it fetches nothing.
    let calls = 0;
    const deps: DrainDeps = {
      ...makeDeps(boss),
      now: () => (calls++ < 2 ? 0 : 1_000_000_000),
    };

    const summary = await drainHotQueues(deps);

    expect(boss.fetch).toHaveBeenCalledTimes(1);
    expect(boss.fetch).toHaveBeenCalledWith(EVENTS, { batchSize: 10 });
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
