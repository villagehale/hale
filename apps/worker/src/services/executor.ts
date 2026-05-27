import { logger } from '../logger.js';
import type { ApprovedAction } from '@mira/types';

interface ExecutorRunInput {
  familyId: string;
  approved: ApprovedAction & { agentRunId: string };
}

/**
 * Executor service — mostly deterministic dispatch + Computer Use for
 * portal automation. No LLM calls except inside the Computer Use path.
 *
 * STUB: logs the action that would be executed. Real version dispatches
 * by action_type to Gmail/Calendar/Stripe/PDF/Computer Use adapters and
 * persists the result + audit_log row.
 */
export async function runExecutor(input: ExecutorRunInput): Promise<void> {
  logger.info(
    {
      familyId: input.familyId,
      actionType: input.approved.actionType,
      actionId: input.approved.id,
    },
    'executor: stub dispatch',
  );
}
