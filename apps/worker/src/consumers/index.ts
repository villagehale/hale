import type PgBoss from 'pg-boss';
import { logger } from '../logger.js';
import { runOrchestrator } from '../orchestrator/index.js';
import { runMemoryInferencer } from '../agents/memory-inferencer.js';
import { runDailyDigest } from '../services/daily-digest.js';

/**
 * Register all pg-boss queue consumers. Each queue corresponds to a stage
 * in the deterministic Orchestrator state machine, plus periodic jobs.
 */
export async function registerConsumers(boss: PgBoss): Promise<void> {
  // Hot path: every inbound event flows through here.
  await boss.work('events.ingested', { batchSize: 5 }, async ([job]) => {
    if (!job) return;
    logger.debug({ jobId: job.id }, 'event ingested');
    await runOrchestrator(job.data as Parameters<typeof runOrchestrator>[0]);
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

  logger.info('consumers registered: events.ingested, memory.inference.due, digest.daily.due');
}
