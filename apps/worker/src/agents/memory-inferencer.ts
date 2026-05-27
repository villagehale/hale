import { logger } from '../logger.js';

interface MemoryInferencerJob {
  familyId: string;
  windowDays: number;
}

/**
 * Memory Inferencer — Claude Sonnet 4.6, batched.
 *
 * Runs nightly per family. Reads recent events + actions, infers patterns
 * and preferences, writes back to family_memory_facts and family_memory_episodes.
 *
 * STUB: logs and returns. Real version reads memory snapshot + recent events,
 * invokes Claude with structured output schema.
 */
export async function runMemoryInferencer(job: MemoryInferencerJob): Promise<void> {
  logger.info(
    { familyId: job.familyId, windowDays: job.windowDays },
    'memory inferencer: stub run',
  );
}
