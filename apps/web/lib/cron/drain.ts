import {
  approvedActionPayloadSchema,
  type ChannelMessageReceivedPayload,
  channelMessageReceivedPayloadSchema,
  channelSendJobPayloadSchema,
  ingestedEventPayloadSchema,
  rerankJobPayloadSchema,
} from '@hale/tools-contracts';
import {
  defaultExecuteApprovedDeps,
  executeApprovedAction,
  runOrchestrator,
} from '@hale/worker/orchestrator';
import PgBoss from 'pg-boss';
import {
  CHANNEL_MESSAGE_RECEIVED_POLICY,
  CHANNEL_MESSAGE_RECEIVED_QUEUE,
  CHANNEL_SEND_QUEUE,
} from '~/lib/channel/config';
import type { LoopMessage } from '~/lib/channel/types';

/**
 * Serverless drain of the two HOT worker queues — `events.ingested` and
 * `actions.approved` — running the SAME orchestrator pipeline the Fly worker
 * would, from a Vercel cron. The Fly worker is not deployed, so without this
 * these jobs were enqueued (by the accept + approve routes) and never consumed,
 * so "add to my week" silently did nothing.
 *
 * Every orchestrator gate is preserved because we reuse runOrchestrator /
 * executeApprovedAction verbatim (rule #3 reviewer tool-coverage, #7 spending
 * cap, #1 teen-redaction, #6 audit, plus agent_runs telemetry) — this module is
 * only the queue-drain shell around them.
 *
 * The other periodic queues (memory.inference / digest / discovery) are already
 * their own Vercel crons and are deliberately NOT touched here.
 */

const EVENTS_QUEUE = 'events.ingested';
const ACTIONS_QUEUE = 'actions.approved';
/** Background feed-rank materialization: a job carries {family_id}; the handler
 * runs the ~25s ranker OUT of the request path and stores the order in
 * village_feed_rank, so the home feed read is a pure DB lookup. */
const RERANK_QUEUE = 'village.rerank';

/** Per-job expiry: a killed pipeline re-queues in ~3min, not the 15min default
 * (recipe #6). Set on queue creation AND mirrored on the producer send. */
export const HOT_QUEUE_EXPIRE_SECONDS = 180;

/** Bound a single drain run so it stays well under maxDuration 800 and can never
 * block the next tick. Each batch is fetched, processed, then the budget is
 * re-checked before fetching the next. */
const BATCH_SIZE = 10;
const WALL_CLOCK_BUDGET_MS = 700_000;

/**
 * The slice `channel.send` drains under before anything else runs (G7).
 *
 * It is a SLICE, not a priority: a share big enough that a normal outbound backlog
 * clears in the same tick it was enqueued, small enough that a stuck send queue can
 * never become the new thing starving the parent whose text is waiting behind it.
 * Both directions are pinned by test.
 */
const CHANNEL_SEND_BUDGET_MS = 120_000;

/** The minimal pg-boss surface the drain loop uses — injected so the
 * fetch/complete/fail/expiry control flow is unit-testable without a live
 * pg-boss (rule #8: this fakes the QUEUE, never the LLM). */
export interface DrainBoss {
  createQueue(
    name: string,
    options?: { name: string; expireInSeconds?: number; policy?: string },
  ): Promise<void>;
  fetch<T>(name: string, options: { batchSize: number }): Promise<Array<{ id: string; data: T }>>;
  complete(name: string, id: string): Promise<void>;
  fail(name: string, id: string, data: object): Promise<void>;
}

export interface DrainHandlers {
  runOrchestrator: typeof runOrchestrator;
  executeApprovedAction: typeof executeApprovedAction;
  /** Materialize one family's feed rank (upsertFeedRank), bound to a db by the
   * caller — injected so the drain loop is testable without a real ranker/db. */
  rerank: (familyId: string) => Promise<void>;
  /** Dispatch one loop message through the channel seam (consent/quiet/cap/dedupe/
   * ledger), bound to a db + the real adapters by the caller. A transient channel
   * error throws so the job re-queues; a permanent one records a failed row and
   * completes. Injected so the drain loop is testable without a live provider. */
  channelSend: (message: LoopMessage) => Promise<void>;
  /** Route one inbound text through C1 (VIL-220), bound to a db + the real ports by
   * the caller. A throw re-queues the job; the parent's message is already durably on
   * the ledger, so a retry re-reads it rather than losing it. Injected so the drain
   * loop is testable without a transport, a model, or a db. */
  channelMessage: (job: ChannelMessageReceivedPayload) => Promise<void>;
}

export interface DrainDeps {
  boss: DrainBoss;
  handlers: DrainHandlers;
  log: Pick<Console, 'info' | 'error'>;
  now: () => number;
}

export interface DrainSummary {
  processed: number;
  failed: number;
  dropped: number;
}

/**
 * Drive one `events.ingested` job through the orchestrator. A schema-invalid
 * payload is DROPPED (completed) not failed — it can never become valid on a
 * retry, so failing it would only spin pg-boss's retry loop. Mirrors the
 * worker's handleIngestedEvent drop-don't-throw policy. A handler throw is
 * propagated so the caller fails (not completes) the job — at-least-once
 * redelivery then re-runs it, and the orchestrator's own dedup-hash checkpoint
 * makes that re-run idempotent (no double draft / audit row).
 */
async function processIngestedJob(
  deps: DrainDeps,
  job: { id: string; data: unknown },
): Promise<'processed' | 'dropped'> {
  const parsed = ingestedEventPayloadSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.log.error(
      { queue: EVENTS_QUEUE, jobId: job.id, issues: parsed.error.issues },
      'drain: events.ingested payload failed contract validation — dropping',
    );
    return 'dropped';
  }
  await deps.handlers.runOrchestrator(parsed.data);
  return 'processed';
}

/** Drive one `actions.approved` job into execution. Same drop-don't-throw policy
 * for a schema-invalid payload; executeApprovedAction itself drops (never
 * throws) a non-approvable action, so a re-run after expiry is idempotent. */
async function processApprovedJob(
  deps: DrainDeps,
  job: { id: string; data: unknown },
): Promise<'processed' | 'dropped'> {
  const parsed = approvedActionPayloadSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.log.error(
      { queue: ACTIONS_QUEUE, jobId: job.id, issues: parsed.error.issues },
      'drain: actions.approved payload failed contract validation — dropping',
    );
    return 'dropped';
  }
  await deps.handlers.executeApprovedAction({
    actionId: parsed.data.action_id,
    familyId: parsed.data.family_id,
    approvedBy: parsed.data.approved_by,
  });
  return 'processed';
}

/** Drive one `village.rerank` job into background rank materialization. Same
 * drop-don't-throw policy for a schema-invalid payload; upsertFeedRank itself
 * short-circuits an unchanged candidate set (no model call, rule #7), so a re-run
 * after expiry is idempotent and free when nothing changed. */
async function processRerankJob(
  deps: DrainDeps,
  job: { id: string; data: unknown },
): Promise<'processed' | 'dropped'> {
  const parsed = rerankJobPayloadSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.log.error(
      { queue: RERANK_QUEUE, jobId: job.id, issues: parsed.error.issues },
      'drain: village.rerank payload failed contract validation — dropping',
    );
    return 'dropped';
  }
  await deps.handlers.rerank(parsed.data.family_id);
  return 'processed';
}

/** Drive one `channel.send` job into the loop dispatch. Same drop-don't-throw
 * policy for a schema-invalid payload. A handler throw (transient channel error)
 * propagates → boss.fail → redelivery with backoff; a permanent failure records a
 * `failed` ledger row and returns, so the job completes and does not retry. The
 * dedupe key makes a redelivery idempotent (a re-drain can never double-send). */
async function processChannelSendJob(
  deps: DrainDeps,
  job: { id: string; data: unknown },
): Promise<'processed' | 'dropped'> {
  const parsed = channelSendJobPayloadSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.log.error(
      { queue: CHANNEL_SEND_QUEUE, jobId: job.id, issues: parsed.error.issues },
      'drain: channel.send payload failed contract validation — dropping',
    );
    return 'dropped';
  }
  await deps.handlers.channelSend(parsed.data);
  return 'processed';
}

/**
 * Drive one inbound text through the router (VIL-220 · C1). Same drop-don't-throw
 * policy for a schema-invalid payload.
 *
 * A handler throw propagates → boss.fail → redelivery. That is safe to retry because
 * the payload carries only POINTERS: the parent's message is on the channel_messages
 * row A3 wrote, so a re-run re-reads the same text rather than losing it.
 *
 * It is at-least-once, not exactly-once, and the two visible artifacts of a mid-turn
 * crash are a duplicated `messages` row for the parent's turn and a re-sent reply.
 * Neither is a wrong answer: the approvals spine refuses a second approval of an action
 * that has left `drafted_for_approval`, so a retry produces the honest failure line
 * rather than acting twice, and the singleton policy keeps a retry in order rather than
 * interleaved with a newer text. De-duplicating the turn itself would need a key on
 * `messages`, which is a schema change this ticket deliberately does not make.
 */
async function processChannelMessageJob(
  deps: DrainDeps,
  job: { id: string; data: unknown },
): Promise<'processed' | 'dropped'> {
  const parsed = channelMessageReceivedPayloadSchema.safeParse(job.data);
  if (!parsed.success) {
    deps.log.error(
      { queue: CHANNEL_MESSAGE_RECEIVED_QUEUE, jobId: job.id, issues: parsed.error.issues },
      'drain: channel.message.received payload failed contract validation — dropping',
    );
    return 'dropped';
  }
  await deps.handlers.channelMessage(parsed.data);
  return 'processed';
}

/**
 * Fetch + process a single queue until it drains or the wall-clock budget expires.
 * Each job: complete() on a clean run / drop, fail() on a handler throw — a failed job
 * is NEVER silently completed (recipe #1), so a transient crash re-queues rather than
 * vanishing.
 *
 * EMPTINESS is the only stop condition. A short batch used to end the run as a
 * "queue is nearly empty" heuristic, and that heuristic is FALSE for a singleton
 * queue by construction: pg-boss hands back at most one job per singleton key per
 * fetch, so `channel.message.received` returns a short batch on every fetch and a
 * parent's second text waited for the next cron tick.
 */
async function drainQueue(
  deps: DrainDeps,
  queue: string,
  process: (
    deps: DrainDeps,
    job: { id: string; data: unknown },
  ) => Promise<'processed' | 'dropped'>,
  deadlineMs: number,
  summary: DrainSummary,
): Promise<void> {
  while (deps.now() < deadlineMs) {
    const jobs = await deps.boss.fetch<unknown>(queue, { batchSize: BATCH_SIZE });
    if (jobs.length === 0) return;

    for (const job of jobs) {
      try {
        const outcome = await process(deps, job);
        await deps.boss.complete(queue, job.id);
        if (outcome === 'processed') summary.processed += 1;
        else summary.dropped += 1;
      } catch (err) {
        summary.failed += 1;
        deps.log.error({ queue, jobId: job.id, err }, 'drain: handler threw — failing job');
        await deps.boss.fail(queue, job.id, {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

/**
 * The injectable core: drain both hot queues under the run's deps. Exposed for
 * tests; the route calls runDrainCron, which builds the real pg-boss deps.
 */
export async function drainHotQueues(deps: DrainDeps): Promise<DrainSummary> {
  await deps.boss.createQueue(EVENTS_QUEUE, {
    name: EVENTS_QUEUE,
    expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
  });
  await deps.boss.createQueue(ACTIONS_QUEUE, {
    name: ACTIONS_QUEUE,
    expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
  });
  await deps.boss.createQueue(RERANK_QUEUE, {
    name: RERANK_QUEUE,
    expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
  });
  await deps.boss.createQueue(CHANNEL_SEND_QUEUE, {
    name: CHANNEL_SEND_QUEUE,
    expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
  });
  // The one queue with a POLICY. Per-conversation FIFO is a property of the queue, not
  // of this loop: pg-boss only enforces a singleton key where the policy says to, and
  // it hands out at most one job per key per fetch. Created here as well as by the
  // producer so a cold start in either order lands the same queue.
  await deps.boss.createQueue(CHANNEL_MESSAGE_RECEIVED_QUEUE, {
    name: CHANNEL_MESSAGE_RECEIVED_QUEUE,
    expireInSeconds: HOT_QUEUE_EXPIRE_SECONDS,
    policy: CHANNEL_MESSAGE_RECEIVED_POLICY,
  });

  const startedMs = deps.now();
  const deadlineMs = startedMs + WALL_CLOCK_BUDGET_MS;
  const summary: DrainSummary = { processed: 0, failed: 0, dropped: 0 };

  // Outbound sends FIRST, under their own slice. These jobs carry a message Hale has
  // ALREADY decided to send — a weekly brief, a reminder — so every second they wait is
  // pure delay on a decision that is finished. They used to drain last, behind two
  // LLM-bound queues sharing one deadline, which meant an inference backlog withheld a
  // composed message for the whole tick and the summary said nothing about it. The slice
  // is what keeps the reordering honest in both directions: a stuck send queue hands the
  // rest of the tick back rather than becoming the new starvation.
  await drainQueue(
    deps,
    CHANNEL_SEND_QUEUE,
    processChannelSendJob,
    Math.min(startedMs + CHANNEL_SEND_BUDGET_MS, deadlineMs),
    summary,
  );
  // Inbound turns next. It is the queue with a parent holding a phone waiting on it, and
  // it must precede actions.approved: a texted "YES" enqueues its approval from inside
  // the turn, so approvals drained first would always miss it by a full tick.
  await drainQueue(
    deps,
    CHANNEL_MESSAGE_RECEIVED_QUEUE,
    processChannelMessageJob,
    deadlineMs,
    summary,
  );
  await drainQueue(deps, EVENTS_QUEUE, processIngestedJob, deadlineMs, summary);
  await drainQueue(deps, ACTIONS_QUEUE, processApprovedJob, deadlineMs, summary);
  await drainQueue(deps, RERANK_QUEUE, processRerankJob, deadlineMs, summary);

  deps.log.info({ ...summary }, 'drain: run complete');
  return summary;
}

/**
 * Connection (recipe #4): pg-boss requires prepared statements, which Supabase's
 * TRANSACTION pooler (port 6543) breaks. We connect via DATABASE_DIRECT_URL —
 * the direct/session 5432 URL already used for DDL/migrations — falling back to
 * DATABASE_URL only when it is unset. `supervise: false` (recipe #1): no
 * background maintenance loop in the drain function; the separate
 * queue-maintenance cron owns boss.maintain().
 */
export async function runDrainCron(): Promise<DrainSummary> {
  const connectionString = process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_DIRECT_URL or DATABASE_URL must be set to drain the queue');
  }

  // Lazily imported here, not at module top: upsertFeedRank pulls the village
  // read chain (queries → family → auth) which drags next-auth into every test
  // that imports a drain constant. The runtime entrypoint is the only place that
  // needs the real handler, so the import stays scoped to it.
  const { db } = await import('~/lib/db');
  const { upsertFeedRank } = await import('~/lib/village/rank/upsert');

  // The channel seam pulls the loop dispatch + adapters (and the db-backed ports);
  // scoped to the runtime entrypoint so importing a drain constant stays test-light.
  const { routeInboundChannelMessage } = await import('~/lib/channel/router/wiring');
  const { dispatchLoopMessage } = await import('~/lib/channel/dispatch');
  const { buildDispatchPorts } = await import('~/lib/channel/wiring');
  const { loopTemplateRenderer } = await import('~/lib/loop/templates/registry');
  const { productionChannels } = await import('~/lib/channel/adapters/production');
  const { createCalendarInviteSender } = await import('~/lib/loop/calendar-invite');
  const { productionCalendarVoice } = await import('~/lib/loop/voice/calendar-invite-voice');

  const channels = productionChannels(db());

  // VIL-249 — the executor's invite port, bound to the SAME adapters the loop sends
  // through. Both execution paths get it: an approved placement (actions.approved) and
  // an autonomous one (events.ingested). Unbound, a placement would land on Hale's
  // calendar and nowhere else, which is the hole this closes.
  const calendarInvites = createCalendarInviteSender(db(), {
    channels,
    renderer: loopTemplateRenderer,
    voice: productionCalendarVoice(),
  });

  const boss = new PgBoss({ connectionString, schema: 'pgboss', supervise: false });
  await boss.start();
  try {
    return await drainHotQueues({
      boss: boss as unknown as DrainBoss,
      handlers: {
        runOrchestrator: (job) => runOrchestrator(job, { calendarInvites }),
        executeApprovedAction: (input) =>
          executeApprovedAction(input, { ...defaultExecuteApprovedDeps(), calendarInvites }),
        rerank: (familyId) => upsertFeedRank(db(), familyId).then(() => undefined),
        channelSend: (message) =>
          dispatchLoopMessage(
            message,
            buildDispatchPorts(db(), { channels, renderer: loopTemplateRenderer }),
          ).then(() => undefined),
        channelMessage: (job) => routeInboundChannelMessage(db(), job),
      },
      log: console,
      now: () => Date.now(),
    });
  } finally {
    await boss.stop({ graceful: true });
  }
}
