import { logger } from '../logger.js';
import { runClassifier } from '../agents/classifier.js';
import { runDrafter } from '../agents/drafter.js';
import { runReviewer } from '../agents/reviewer.js';
import { runExecutor } from '../services/executor.js';
import { recordEvent, recordAction } from '../services/memory-writer.js';

/**
 * Deterministic workflow runner. Section 1.3 of the spec — Orchestrator
 * has no LLM calls of its own; it's a state machine routing jobs through
 * the LLM agents in sequence.
 *
 * Flow:
 *   events.ingested → Classifier
 *     if confidence > 0.85 AND suggested = autonomous_action →
 *       Drafter → Reviewer
 *         if approve → Executor → audit_log
 *         if flag_for_human → human queue
 *         if reject → archive with rationale
 *     if confidence < 0.7 → human queue
 *     if suggested = surface_only → Memory Writer → daily digest
 *     if suggested = ignore → no-op (audit only)
 */
export interface OrchestratorJob {
  family_id: string;
  source: string;
  payload: Record<string, unknown>;
  received_at: string;
}

const CONFIDENCE_AUTONOMY_THRESHOLD = 0.85;
const CONFIDENCE_HUMAN_THRESHOLD = 0.7;

export async function runOrchestrator(job: OrchestratorJob): Promise<void> {
  logger.debug({ familyId: job.family_id, source: job.source }, 'orchestrator: start');

  const classified = await runClassifier({
    familyId: job.family_id,
    source: job.source,
    rawContent: JSON.stringify(job.payload),
  });

  await recordEvent({
    familyId: job.family_id,
    source: job.source,
    eventType: classified.eventType,
    payload: classified.payload,
    classifierConfidence: classified.confidence.score,
    dedupHash: classified.dedupHash,
  });

  if (classified.confidence.score < CONFIDENCE_HUMAN_THRESHOLD) {
    logger.info(
      { familyId: job.family_id, eventType: classified.eventType, confidence: classified.confidence.score },
      'low confidence — routed to human queue',
    );
    return;
  }

  if (classified.suggestion.kind === 'ignore') {
    logger.debug({ eventType: classified.eventType }, 'classifier: ignore');
    return;
  }

  if (classified.suggestion.kind === 'surface_only') {
    logger.debug({ eventType: classified.eventType }, 'classifier: surface only');
    return;
  }

  if (
    classified.suggestion.kind === 'autonomous_action' &&
    classified.confidence.score >= CONFIDENCE_AUTONOMY_THRESHOLD
  ) {
    const draft = await runDrafter({
      familyId: job.family_id,
      event: classified,
      actionType: classified.suggestion.actionType,
    });

    await recordAction({
      familyId: job.family_id,
      eventId: classified.eventId,
      actionType: draft.actionType,
      payload: draft.payload,
      draftedByAgentRunId: draft.agentRunId,
    });

    const verdict = await runReviewer({
      familyId: job.family_id,
      draft,
    });

    if (verdict.kind === 'approve') {
      await runExecutor({
        familyId: job.family_id,
        approved: { ...draft, verdict, approvedAt: new Date().toISOString() },
      });
    } else if (verdict.kind === 'flag_for_human') {
      logger.info({ familyId: job.family_id }, 'reviewer: flagged for human');
    } else {
      logger.info(
        { familyId: job.family_id, rationale: verdict.rationale },
        'reviewer: rejected',
      );
    }
    return;
  }

  // Default: surface for human review.
  logger.info({ familyId: job.family_id, eventType: classified.eventType }, 'routed to drafts');
}
