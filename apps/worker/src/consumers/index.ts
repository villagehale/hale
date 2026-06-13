import type PgBoss from 'pg-boss';
import { approvedActionPayloadSchema, ingestedEventPayloadSchema } from '@haru/tools-contracts';
import { logger } from '../logger.js';
import { executeApprovedAction, runOrchestrator } from '../orchestrator/index.js';
import { runMemoryInferencer } from '../agents/memory-inferencer.js';
import { runDailyDigest } from '../services/daily-digest.js';

interface IngestedEventDeps {
  run: typeof runOrchestrator;
  log: Pick<typeof logger, 'debug' | 'error'>;
}

interface ApprovedActionDeps {
  run: typeof executeApprovedAction;
  log: Pick<typeof logger, 'debug' | 'error'>;
}

/**
 * Validate an `events.ingested` job against the shared contract, then dispatch
 * to the orchestrator. A schema-invalid payload is logged and dropped — it will
 * never become valid on retry, so throwing would only spin pg-boss's retry loop.
 * Pure (deps injected) so the parse-failure path is unit-testable without a queue.
 */
export async function handleIngestedEvent(
  jobId: string,
  data: unknown,
  deps: IngestedEventDeps = { run: runOrchestrator, log: logger },
): Promise<void> {
  const parsed = ingestedEventPayloadSchema.safeParse(data);
  if (!parsed.success) {
    deps.log.error(
      { jobId, issues: parsed.error.issues },
      'events.ingested: payload failed contract validation — dropping',
    );
    return;
  }
  deps.log.debug({ jobId }, 'event ingested');
  await deps.run(parsed.data);
}

/**
 * Validate an `actions.approved` job against the shared contract, then drive the
 * human-approved action into execution (definition-of-done box 3, worker half).
 * Same drop-don't-throw policy as handleIngestedEvent: a schema-invalid payload
 * never becomes valid on retry. Pure (deps injected) so the parse-failure path
 * is unit-testable without a queue.
 */
export async function handleApprovedAction(
  jobId: string,
  data: unknown,
  deps: ApprovedActionDeps = { run: executeApprovedAction, log: logger },
): Promise<void> {
  const parsed = approvedActionPayloadSchema.safeParse(data);
  if (!parsed.success) {
    deps.log.error(
      { jobId, issues: parsed.error.issues },
      'actions.approved: payload failed contract validation — dropping',
    );
    return;
  }
  deps.log.debug({ jobId }, 'action approved');
  await deps.run({
    actionId: parsed.data.action_id,
    familyId: parsed.data.family_id,
    approvedBy: parsed.data.approved_by,
  });
}

/**
 * Register all pg-boss queue consumers. Each queue corresponds to a stage
 * in the deterministic Orchestrator state machine, plus periodic jobs.
 */
export async function registerConsumers(boss: PgBoss): Promise<void> {
  // Hot path: every inbound event flows through here.
  await boss.work('events.ingested', { batchSize: 5 }, async ([job]) => {
    if (!job) return;
    await handleIngestedEvent(job.id, job.data);
  });

  // Human-approve → execute: a parent approving a drafted action in the UI
  // enqueues here; the worker drives it into execution.
  await boss.work('actions.approved', async ([job]) => {
    if (!job) return;
    await handleApprovedAction(job.id, job.data);
  });

  // Nightly inference batch.
  await boss.work('memory.inference.due', async ([job]) => {
    if (!job) return;
    await runMemoryInferencer(job.data as Parameters<typeof runMemoryInferencer>[0]);
  });

  // Daily digest generator.
  await boss.work('digest.daily.due', async ([job]) => {
    if (!job) return;
    await runDailyDigest(job.data as Parameters<typeof runDailyDigest>[0]);
  });

  logger.info(
    'consumers registered: events.ingested, actions.approved, memory.inference.due, digest.daily.due',
  );
}
