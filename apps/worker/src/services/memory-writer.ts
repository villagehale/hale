import { eq, sql } from 'drizzle-orm';
import { schema } from '@mira/db';
import type { EventType, ActionType, ReviewerVerdict } from '@mira/types';
import { db } from '../db.js';
import { logger } from '../logger.js';

interface AuditWriteInput {
  familyId: string;
  actor: string;
  actionTaken: string;
  targetTable?: string;
  targetId?: string;
  before?: unknown;
  after?: unknown;
  agentRunId?: string;
}

/**
 * Append a row to audit_log. Constraint: every action transition produces
 * one of these. Append-only — never updated.
 */
export async function appendAuditEntry(input: AuditWriteInput): Promise<void> {
  await db()
    .insert(schema.auditLog)
    .values({
      familyId: input.familyId,
      actor: input.actor,
      actionTaken: input.actionTaken,
      targetTable: input.targetTable,
      targetId: input.targetId,
      before: input.before,
      after: input.after,
      agentRunId: input.agentRunId,
    });
}

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

  await appendAuditEntry({
    familyId: input.familyId,
    actor: 'system',
    actionTaken: 'event.classified',
    targetTable: 'events',
    targetId: inserted.id,
    after: { eventType: input.eventType, confidence: input.classifierConfidence },
  });

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

  await appendAuditEntry({
    familyId: input.familyId,
    actor: input.draftedByAgentRunId,
    actionTaken: 'action.drafted',
    targetTable: 'actions',
    targetId: inserted.id,
    after: { actionType: input.actionType },
    agentRunId: input.draftedByAgentRunId,
  });

  return inserted.id;
}

export async function recordReviewerVerdict(input: RecordReviewerVerdictInput): Promise<void> {
  const verdictColumn =
    input.verdict.kind === 'approve'
      ? 'approved'
      : input.verdict.kind === 'reject'
        ? 'rejected'
        : 'flagged';

  const existing = await db()
    .select({ familyId: schema.actions.familyId })
    .from(schema.actions)
    .where(eq(schema.actions.id, input.actionId))
    .limit(1);
  const familyId = existing[0]?.familyId;
  if (!familyId) {
    throw new Error(`recordReviewerVerdict: action ${input.actionId} not found`);
  }

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

  await appendAuditEntry({
    familyId,
    actor: 'system',
    actionTaken: `action.reviewer.${verdictColumn}`,
    targetTable: 'actions',
    targetId: input.actionId,
    after: {
      verdict: verdictColumn,
      rationale: input.verdict.rationale,
      toolResults: input.verdict.toolResults.map((r) => ({ tool: r.tool, ok: r.ok })),
    },
  });
}

export async function recordExecution(input: RecordExecutionInput): Promise<void> {
  const existing = await db()
    .select({ familyId: schema.actions.familyId })
    .from(schema.actions)
    .where(eq(schema.actions.id, input.actionId))
    .limit(1);
  const familyId = existing[0]?.familyId;
  if (!familyId) {
    throw new Error(`recordExecution: action ${input.actionId} not found`);
  }

  await db()
    .update(schema.actions)
    .set({
      executedAt: new Date(),
      executorResult: input.result,
      userVisibleState: input.ok ? 'autonomous' : 'needs_human',
    })
    .where(eq(schema.actions.id, input.actionId));

  await appendAuditEntry({
    familyId,
    actor: 'system',
    actionTaken: input.ok ? 'action.executed' : 'action.execution_failed',
    targetTable: 'actions',
    targetId: input.actionId,
    after: input.result,
  });
}
