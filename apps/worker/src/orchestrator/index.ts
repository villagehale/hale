import { logger } from '../logger.js';
import { runClassifier } from '../agents/classifier.js';
import { runDrafter } from '../agents/drafter.js';
import { runReviewer } from '../agents/reviewer.js';
import { runExecutor } from '../services/executor.js';
import {
  recordEvent,
  recordAction,
  recordReviewerVerdict,
  recordExecution,
} from '../services/memory-writer.js';
import type { ActionType } from '@mira/types';

const CONFIDENCE_AUTONOMY_THRESHOLD = 0.85;
const CONFIDENCE_HUMAN_THRESHOLD = 0.7;

const KNOWN_ACTION_TYPES: ReadonlySet<ActionType> = new Set<ActionType>([
  'send_email',
  'reply_to_email',
  'create_calendar_event',
  'update_calendar_event',
  'place_supply_order',
  'cancel_supply_order',
  'fill_pdf_form',
  'submit_government_form',
  'book_clinic_portal',
  'cancel_clinic_appointment',
  'share_photos_with_family',
  'add_to_digest_only',
]);

/**
 * Deterministic workflow runner. Spec §1.3 — Orchestrator has no LLM
 * calls of its own; it routes jobs through the LLM agents and
 * deterministic services in sequence and records everything.
 */
export interface OrchestratorJob {
  family_id: string;
  source: string;
  payload: Record<string, unknown>;
  received_at: string;
}

export async function runOrchestrator(job: OrchestratorJob): Promise<void> {
  const familyId = job.family_id;
  logger.debug({ familyId, source: job.source }, 'orchestrator: start');

  // 1. Classify
  const classified = await runClassifier({
    familyId,
    source: job.source,
    rawContent: JSON.stringify(job.payload),
  });

  // 2. Record event (idempotent on dedup_hash)
  const { eventId, duplicate } = await recordEvent({
    familyId,
    source: job.source,
    eventType: classified.eventType,
    payload: classified.payload,
    classifierConfidence: classified.confidence.score,
    dedupHash: classified.dedupHash,
  });

  if (duplicate) {
    logger.debug({ familyId, eventId }, 'orchestrator: duplicate event, skipping downstream');
    return;
  }

  // 3. Route by confidence + suggestion
  if (classified.confidence.score < CONFIDENCE_HUMAN_THRESHOLD) {
    logger.info(
      { familyId, eventId, confidence: classified.confidence.score },
      'orchestrator: low classifier confidence — routed to human queue',
    );
    return;
  }

  if (classified.suggestion.kind === 'ignore' || classified.suggestion.kind === 'surface_only') {
    logger.debug(
      { familyId, eventId, kind: classified.suggestion.kind },
      'orchestrator: classifier routed to digest only',
    );
    return;
  }

  if (classified.suggestion.kind === 'needs_human') {
    logger.info({ familyId, eventId }, 'orchestrator: classifier flagged needs_human');
    return;
  }

  if (classified.suggestion.kind !== 'autonomous_action') {
    logger.debug({ familyId, eventId }, 'orchestrator: classifier did not suggest autonomous action');
    return;
  }

  const actionType = classified.suggestion.actionType as ActionType;
  if (!KNOWN_ACTION_TYPES.has(actionType)) {
    logger.warn(
      { familyId, eventId, actionType },
      'orchestrator: classifier proposed unknown action_type — routed to human queue',
    );
    return;
  }

  // Draft + Review run for everything ≥ HUMAN_THRESHOLD. The autonomy
  // threshold gates *execution*, not drafting. This is what populates
  // /drafts for the mid-confidence band the classifier prompt produces.
  const draft = await runDrafter({
    familyId,
    event: { eventId, eventType: classified.eventType, payload: classified.payload },
    actionType,
  });

  const actionId = await recordAction({
    familyId,
    eventId,
    actionType: draft.actionType,
    payload: draft.payload,
    draftedByAgentRunId: draft.agentRunId,
  });

  const verdict = await runReviewer({ familyId, draft });
  await recordReviewerVerdict({ actionId, verdict });

  if (verdict.kind !== 'approve') {
    logger.info(
      { familyId, actionId, verdict: verdict.kind, rationale: verdict.rationale },
      'orchestrator: reviewer did not approve — surfaced to user',
    );
    return;
  }

  if (classified.confidence.score < CONFIDENCE_AUTONOMY_THRESHOLD) {
    logger.info(
      { familyId, actionId, confidence: classified.confidence.score },
      'orchestrator: reviewer approved but confidence below autonomy threshold — drafted for approval',
    );
    return;
  }

  try {
    const execution = await runExecutor({
      familyId,
      approved: { ...draft, verdict, approvedAt: new Date().toISOString() },
    });
    await recordExecution({ actionId, result: execution.detail, ok: execution.ok });
    logger.info({ familyId, actionId }, 'orchestrator: action executed');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown executor error';
    logger.error({ familyId, actionId, err }, 'orchestrator: executor failed');
    await recordExecution({ actionId, result: { error: message }, ok: false });
  }
}
