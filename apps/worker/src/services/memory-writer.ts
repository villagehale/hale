import { eq, sql } from 'drizzle-orm';
import { schema } from '@mira/db';
import type { EventType, ActionType, ReviewerVerdict } from '@mira/types';
import { db } from '../db.js';
import { logger } from '../logger.js';

interface RecordEventInput {
  familyId: string;
  source: string;
  sourceExternalId?: string;
  eventType: EventType;
  payload: Record<string, unknown>;
  classifierConfidence: number;
  dedupHash: string;
}

interface RecordActionInput {
  familyId: string;
  eventId: string;
  actionType: ActionType;
  payload: Record<string, unknown>;
  draftedByAgentRunId: string;
}

interface RecordReviewerVerdictInput {
  actionId: string;
  verdict: ReviewerVerdict;
}

interface RecordExecutionInput {
  actionId: string;
  result: Record<string, unknown>;
  ok: boolean;
}

/**
 * Memory Writer — deterministic Postgres writes. No LLM.
 *
 * Single source of truth for what the agents can later see. Idempotent
 * on (family_id, dedup_hash) for events so re-deliveries don't double-
 * process.
 */

export async function recordEvent(input: RecordEventInput): Promise<{ eventId: string; duplicate: boolean }> {
  const result = await db()
    .insert(schema.events)
    .values({
      familyId: input.familyId,
      source: input.source,
      sourceExternalId: input.sourceExternalId,
      eventType: input.eventType,
      payload: input.payload,
      classifierConfidence: input.classifierConfidence,
      classifiedAt: new Date(),
      dedupHash: input.dedupHash,
      status: 'classified',
    })
    .onConflictDoNothing({ target: [schema.events.familyId, schema.events.dedupHash] })
    .returning({ id: schema.events.id });

  if (result.length === 0) {
    // Conflict — fetch the existing row's id for the caller.
    const existing = await db()
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(sql`${schema.events.familyId} = ${input.familyId} AND ${schema.events.dedupHash} = ${input.dedupHash}`)
      .limit(1);
    const existingId = existing[0]?.id;
    if (!existingId) {
      throw new Error('event conflict but no existing row found — investigate');
    }
    logger.debug({ familyId: input.familyId, eventId: existingId }, 'memory: duplicate event ignored');
    return { eventId: existingId, duplicate: true };
  }

  const inserted = result[0];
  if (!inserted) {
    throw new Error('insert returned empty result — investigate');
  }
  logger.debug({ familyId: input.familyId, eventId: inserted.id }, 'memory: event recorded');
  return { eventId: inserted.id, duplicate: false };
}

export async function recordAction(input: RecordActionInput): Promise<string> {
  const result = await db()
    .insert(schema.actions)
    .values({
      eventId: input.eventId,
      familyId: input.familyId,
      actionType: input.actionType,
      payload: input.payload,
      draftedByAgentRunId: input.draftedByAgentRunId,
      reviewerVerdict: 'pending',
      userVisibleState: 'drafted_for_approval',
    })
    .returning({ id: schema.actions.id });

  const inserted = result[0];
  if (!inserted) {
    throw new Error('action insert returned empty result');
  }
  return inserted.id;
}

export async function recordReviewerVerdict(input: RecordReviewerVerdictInput): Promise<void> {
  const verdictColumn =
    input.verdict.kind === 'approve'
      ? 'approved'
      : input.verdict.kind === 'reject'
        ? 'rejected'
        : 'flagged';

  await db()
    .update(schema.actions)
    .set({
      reviewerVerdict: verdictColumn,
      reviewerVerdictAt: new Date(),
      reviewerToolResults: input.verdict.toolResults.map((r) => ({
        tool: r.tool,
        result: r.result,
      })),
      userVisibleState:
        input.verdict.kind === 'approve' ? 'drafted_for_approval' : 'needs_human',
    })
    .where(eq(schema.actions.id, input.actionId));
}

export async function recordExecution(input: RecordExecutionInput): Promise<void> {
  await db()
    .update(schema.actions)
    .set({
      executedAt: new Date(),
      executorResult: input.result,
      userVisibleState: input.ok ? 'autonomous' : 'needs_human',
    })
    .where(eq(schema.actions.id, input.actionId));
}
