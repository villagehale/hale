import { logger } from '../logger.js';

interface RecordEventInput {
  familyId: string;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
  classifierConfidence: number;
  dedupHash: string;
}

interface RecordActionInput {
  familyId: string;
  eventId: string;
  actionType: string;
  payload: Record<string, unknown>;
  draftedByAgentRunId: string;
}

/**
 * Memory Writer service — deterministic Postgres writes.
 * No LLM calls. Single source of truth for what agents can see.
 *
 * STUB: logs intent. Real implementation uses Drizzle to insert/upsert
 * with conflict handling on (family_id, dedup_hash) for events.
 */
export async function recordEvent(input: RecordEventInput): Promise<void> {
  logger.debug({ familyId: input.familyId, eventType: input.eventType }, 'memory: record event');
}

export async function recordAction(input: RecordActionInput): Promise<void> {
  logger.debug(
    { familyId: input.familyId, actionType: input.actionType },
    'memory: record action',
  );
}
