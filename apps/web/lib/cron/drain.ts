import {
  approvedActionPayloadSchema,
  channelSendJobPayloadSchema,
  ingestedEventPayloadSchema,
  rerankJobPayloadSchema,
} from '@hale/tools-contracts';
import { executeApprovedAction, runOrchestrator } from '@hale/worker/orchestrator';
import PgBoss from 'pg-boss';
import { CHANNEL_SEND_QUEUE } from '~/lib/channel/config';
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

/** The minimal pg-boss surface the drain loop uses — injected so the
 * fetch/complete/fail/expiry control flow is unit-testable without a live
 * pg-boss (rule #8: this fakes the QUEUE, never the LLM). */
export interface DrainBoss {
  createQueue(name: string, options?: { name: string; expireInSeconds?: number }): Promise<void>;
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
 * Fetch + process a single queue in bounded batches until it drains, the batch
 * cap is hit, or the wall-clock budget expires. Each job: complete() on a clean
 * run / drop, fail() on a handler throw — a failed job is NEVER silently
 * completed (recipe #1), so a transient crash re-queues rather than vanishing.
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

    if (jobs.length < BATCH_SIZE) return;
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

  const deadlineMs = deps.now() + WALL_CLOCK_BUDGET_MS;
  const summary: DrainSummary = { processed: 0, failed: 0, dropped: 0 };

  await drainQueue(deps, EVENTS_QUEUE, processIngestedJob, deadlineMs, summary);
  await drainQueue(deps, ACTIONS_QUEUE, processApprovedJob, deadlineMs, summary);
  await drainQueue(deps, RERANK_QUEUE, processRerankJob, deadlineMs, summary);
  await drainQueue(deps, CHANNEL_SEND_QUEUE, processChannelSendJob, deadlineMs, summary);

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
  const { dispatchLoopMessage } = await import('~/lib/channel/dispatch');
  const { buildDispatchPorts } = await import('~/lib/channel/wiring');
  const { defaultLoopRenderer } = await import('~/lib/channel/renderer');
  const { createResendEmailChannel } = await import('~/lib/channel/adapters/resend-email');
  const { createExpoPushChannelAdapter } = await import('~/lib/channel/adapters/expo-push');
  const { createTwilioSmsChannel } = await import('~/lib/channel/adapters/twilio-sms');
  const { createExpoPushChannel } = await import('~/lib/push/channel');
  const { createExpoPushClient } = await import('~/lib/push/expo-client');
  const { schema } = await import('@hale/db');
  const { eq } = await import('drizzle-orm');

  const channels = {
    email: createResendEmailChannel({
      resolveEmail: async (userId: string) => {
        const rows = await db()
          .select({ email: schema.users.email })
          .from(schema.users)
          .where(eq(schema.users.id, userId))
          .limit(1);
        return rows[0]?.email ?? null;
      },
    }),
    push: createExpoPushChannelAdapter({
      push: createExpoPushChannel({ database: db(), client: createExpoPushClient() }),
    }),
    sms: createTwilioSmsChannel(),
  };

  const boss = new PgBoss({ connectionString, schema: 'pgboss', supervise: false });
  await boss.start();
  try {
    return await drainHotQueues({
      boss: boss as unknown as DrainBoss,
      handlers: {
        runOrchestrator,
        executeApprovedAction,
        rerank: (familyId) => upsertFeedRank(db(), familyId).then(() => undefined),
        channelSend: (message) =>
          dispatchLoopMessage(
            message,
            buildDispatchPorts(db(), { channels, renderer: defaultLoopRenderer }),
          ).then(() => undefined),
      },
      log: console,
      now: () => Date.now(),
    });
  } finally {
    await boss.stop({ graceful: true });
  }
}
