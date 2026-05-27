import { logger } from '../logger.js';

interface DailyDigestJob {
  familyId: string;
  digestDate: string; // YYYY-MM-DD
}

/**
 * Builds the daily digest for a family: queries today's actions (autonomous,
 * drafted_for_approval, needs_human) and Coach insights, then writes a
 * `daily_digest` row that the web app renders.
 *
 * STUB.
 */
export async function runDailyDigest(job: DailyDigestJob): Promise<void> {
  logger.info({ familyId: job.familyId, date: job.digestDate }, 'daily digest: stub generate');
}
