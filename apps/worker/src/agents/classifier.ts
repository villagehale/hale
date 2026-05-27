import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import type { ClassifierSuggestion, EventType } from '@mira/types';

interface ClassifierRunInput {
  familyId: string;
  source: string;
  rawContent: string;
}

interface ClassifierRunOutput {
  eventId: string;
  eventType: EventType;
  payload: Record<string, unknown>;
  confidence: { score: number; rationale: string };
  suggestion: ClassifierSuggestion;
  dedupHash: string;
}

/**
 * Classifier agent — Claude Haiku 4.5.
 *
 * STUB IMPLEMENTATION: returns a believable mock so the end-to-end pipeline
 * runs while the real prompt is built in Langfuse.
 *
 * Real version invokes Claude Agent SDK with the Langfuse-versioned prompt,
 * passing the family context slice and raw content. Output is validated
 * against ClassifierOutput Zod schema before being returned.
 */
export async function runClassifier(input: ClassifierRunInput): Promise<ClassifierRunOutput> {
  logger.debug({ familyId: input.familyId, source: input.source }, 'classifier: stub run');

  const dedupHash = createHash('sha256').update(input.rawContent).digest('hex');

  return {
    eventId: crypto.randomUUID(),
    eventType: 'pediatric_appointment_reminder',
    payload: { stub: true, source: input.source },
    confidence: { score: 0.94, rationale: 'stub classifier — high confidence mock' },
    suggestion: { kind: 'autonomous_action', actionType: 'reply_to_email' },
    dedupHash,
  };
}
