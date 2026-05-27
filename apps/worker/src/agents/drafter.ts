import { logger } from '../logger.js';
import type { ActionType, DraftedAction } from '@mira/types';

interface DrafterRunInput {
  familyId: string;
  event: {
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
  };
  actionType: string;
}

interface DrafterRunOutput extends DraftedAction {
  agentRunId: string;
}

/**
 * Drafter agent — Claude Sonnet 4.6.
 *
 * STUB: returns a believable mock draft action with reasonable defaults.
 * Real version invokes Claude Agent SDK with the family voice profile
 * loaded from memory.
 */
export async function runDrafter(input: DrafterRunInput): Promise<DrafterRunOutput> {
  logger.debug(
    { familyId: input.familyId, eventType: input.event.eventType },
    'drafter: stub run',
  );

  const id = crypto.randomUUID();
  const agentRunId = crypto.randomUUID();

  return {
    id,
    eventId: input.event.eventId,
    familyId: input.familyId,
    actionType: input.actionType as ActionType,
    payload: {
      to: 'pediatric-office@example.com',
      subject: 'Re: appointment reminder',
      body: 'Thanks — confirming Thursday at 10:00. Pre-visit form attached.',
    },
    draftConfidence: 0.91,
    rationale: 'stub drafter — routine confirmation reply',
    recipientVisibility: 'public',
    draftedAt: new Date().toISOString(),
    agentRunId,
  };
}
