import { type Database, schema } from '@hale/db';
import type {
  ActionType,
  ClassifierSuggestion,
  EventType,
  FamilyStage,
  ReviewerVerdict,
} from '@hale/types';
import { ageInMonths, deriveStage } from '@hale/types';
import { and, asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import { db } from '../db.js';
import { logger } from '../logger.js';
import {
  AUTONOMY_STREAK_REQUIRED,
  autonomyDeniedForKind,
  streakSatisfiesAutonomy,
} from '../orchestrator/autonomy-gate.js';

/**
 * A Drizzle transaction handle — the same query surface as Database, scoped to
 * one BEGIN/COMMIT. Both the domain write and its audit row run against this.
 */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

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
 * recordTransition — THE single writer for any events/actions/agent_runs state
 * change. Runs the caller's domain write and the matching audit_log row inside
 * ONE transaction, so a domain row can never exist without its audit row (hard
 * rule #6) and vice-versa. `domainWrite` returns the audit payload it produced,
 * which may depend on the row it just wrote (e.g. a generated id).
 */
export async function recordTransition<T>(
  domainWrite: (tx: Tx) => Promise<{ audit: AuditWriteInput; value: T }>,
  database: Database = db(),
): Promise<T> {
  return database.transaction(async (tx) => {
    const { audit, value } = await domainWrite(tx);
    await tx.insert(schema.auditLog).values({
      familyId: audit.familyId,
      actor: audit.actor,
      actionTaken: audit.actionTaken,
      targetTable: audit.targetTable,
      targetId: audit.targetId,
      before: audit.before,
      after: audit.after,
      agentRunId: audit.agentRunId,
    });
    return value;
  });
}

/** A query surface with `.insert` — satisfied by both Database and Tx. */
type Inserter = Pick<Database, 'insert'>;

/** A query surface with `.select` — satisfied by both Database and Tx. */
type Reader = Pick<Database, 'select'>;

interface RecordAgentRunInput {
  familyId: string;
  /** Null for runs not yet tied to a persisted event (none today, but the FK allows it). */
  eventId?: string;
  /** Null until the action row exists; set on the drafter run after the action is written. */
  actionId?: string;
  metrics: AgentRunMetrics;
}

/**
 * Inserts one agent_runs row and returns its generated id. Pass a `Tx` to share
 * an open transition (the drafter run shares the action's transaction, so the
 * action's FK to it is never dangling); pass nothing for a standalone run (e.g.
 * the classifier firing on an event that gets dropped before any transition).
 */
export async function recordAgentRun(
  input: RecordAgentRunInput,
  inserter: Inserter = db(),
): Promise<string> {
  const result = await inserter
    .insert(schema.agentRuns)
    .values({
      familyId: input.familyId,
      eventId: input.eventId,
      actionId: input.actionId,
      agentName: input.metrics.agentName,
      modelUsed: input.metrics.modelUsed,
      promptTokens: input.metrics.promptTokens,
      completionTokens: input.metrics.completionTokens,
      cacheReadTokens: input.metrics.cacheReadTokens,
      cacheWriteTokens: input.metrics.cacheWriteTokens,
      costUsd: input.metrics.costUsd.toFixed(6),
      latencyMs: input.metrics.latencyMs,
      completedAt: new Date(),
      status: 'completed',
    })
    .returning({ id: schema.agentRuns.id });

  const runId = result[0]?.id;
  if (!runId) {
    throw new Error('agent_runs insert returned no row');
  }
  return runId;
}

interface RecordEventInput {
  familyId: string;
  source: string;
  sourceExternalId?: string;
  eventType: EventType;
  payload: Record<string, unknown>;
  classifierConfidence: number;
  dedupHash: string;
  /** Persisted so a crash-resume can route without re-classifying (B10). */
  suggestion: ClassifierSuggestion;
  /** Teen-content flag, persisted so a crash-resume re-applies the rule-#1
   * teen-redaction cap with the same value the fresh pass saw (FIX 1). */
  teenContent: boolean;
  /** Which child this event concerns — already validated by the orchestrator
   * against the family's known children (a hallucinated id arrives here as null).
   * Null when undeterminable or family-wide. */
  childId: string | null;
  /** Classifier run metrics — its agent_runs row is written for every event. */
  classifierMetrics: AgentRunMetrics;
}

interface RecordActionInput {
  familyId: string;
  eventId: string;
  actionType: ActionType;
  payload: Record<string, unknown>;
  /** Drafter run metrics — its agent_runs row is written in this transaction. */
  drafterMetrics: AgentRunMetrics;
}

interface RecordReviewerVerdictInput {
  actionId: string;
  verdict: ReviewerVerdict;
  /** Reviewer run metrics — its agent_runs row is written in this transaction. */
  reviewerMetrics: AgentRunMetrics;
}

interface RecordExecutionInput {
  actionId: string;
  result: Record<string, unknown>;
  ok: boolean;
  /** Who decided this ran, and the reviewer's reason. Audited, never persisted on the action. */
  decision: { source: 'autonomous' | 'human'; reason: string };
}

interface RecordDropInput {
  familyId: string;
  eventId: string;
  reason: 'low_confidence' | 'unknown_action_type' | 'needs_human';
  detail: Record<string, unknown>;
}

interface RecordReviewerRejectionInput {
  familyId: string;
  actionId: string;
  verdictKind: ReviewerVerdict['kind'];
  rationale: string;
}

/**
 * Memory Writer — deterministic Postgres writes. No LLM. Every function routes
 * through `recordTransition` so the domain row and its audit row commit atomically.
 *
 * Idempotent on (family_id, dedup_hash) for events so re-deliveries don't double-process.
 */

export async function recordEvent(
  input: RecordEventInput,
  database: Database = db(),
): Promise<{ eventId: string; duplicate: boolean }> {
  // Conflict probe runs outside the transition because a duplicate writes
  // nothing: no domain mutation means no audit row is warranted.
  const inserted = await database
    .insert(schema.events)
    .values({
      familyId: input.familyId,
      source: input.source,
      sourceExternalId: input.sourceExternalId,
      eventType: input.eventType,
      payload: input.payload,
      classifierConfidence: input.classifierConfidence,
      classifierSuggestion: input.suggestion,
      teenContent: input.teenContent,
      childId: input.childId,
      classifiedAt: new Date(),
      dedupHash: input.dedupHash,
      status: 'classified',
    })
    .onConflictDoNothing({ target: [schema.events.familyId, schema.events.dedupHash] })
    .returning({ id: schema.events.id });

  if (inserted.length === 0) {
    const existing = await database
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        sql`${schema.events.familyId} = ${input.familyId} AND ${schema.events.dedupHash} = ${input.dedupHash}`,
      )
      .limit(1);
    const existingId = existing[0]?.id;
    if (!existingId) {
      throw new Error('event conflict but no existing row found — investigate');
    }
    logger.debug(
      { familyId: input.familyId, eventId: existingId },
      'memory: duplicate event ignored',
    );
    // The classifier still ran (and was billed) even though the event is a
    // re-delivery; record its standalone run so cost accounting stays honest.
    await recordAgentRun(
      { familyId: input.familyId, eventId: existingId, metrics: input.classifierMetrics },
      database,
    );
    return { eventId: existingId, duplicate: true };
  }

  const insertedRow = inserted[0];
  if (!insertedRow) {
    throw new Error('event insert returned no row despite non-duplicate path');
  }
  const eventId = insertedRow.id;
  logger.debug({ familyId: input.familyId, eventId }, 'memory: event recorded');

  await recordTransition(async (tx) => {
    await recordAgentRun(
      { familyId: input.familyId, eventId, metrics: input.classifierMetrics },
      tx,
    );
    return {
      value: undefined,
      audit: {
        familyId: input.familyId,
        actor: 'system',
        actionTaken: 'event.classified',
        targetTable: 'events',
        targetId: eventId,
        after: { eventType: input.eventType, confidence: input.classifierConfidence },
      },
    };
  }, database);

  return { eventId, duplicate: false };
}

export async function recordAction(
  input: RecordActionInput,
  database: Database = db(),
): Promise<{ actionId: string; drafterRunId: string | null }> {
  return recordTransition<{ actionId: string; drafterRunId: string | null }>(async (tx) => {
    // FIX 2: claim the action row idempotently FIRST. The unique index on
    // event_id makes a concurrent/redelivered second pass conflict; we load the
    // pre-existing row instead of minting a phantom duplicate. The drafter run
    // is recorded only on the pass that wins the insert, so the loser does not
    // re-bill a run that links to an action it didn't write.
    const inserted = await tx
      .insert(schema.actions)
      .values({
        eventId: input.eventId,
        familyId: input.familyId,
        actionType: input.actionType,
        payload: input.payload,
        reviewerVerdict: 'pending',
        userVisibleState: 'drafted_for_approval',
      })
      .onConflictDoNothing({ target: schema.actions.eventId })
      .returning({ id: schema.actions.id });

    if (inserted.length === 0) {
      const existing = await tx
        .select({ id: schema.actions.id })
        .from(schema.actions)
        .where(eq(schema.actions.eventId, input.eventId))
        .limit(1);
      const existingId = existing[0]?.id;
      if (!existingId) {
        throw new Error('action insert conflicted but no existing row found — investigate');
      }
      // FIX 2 atomic fold: advance the event off 'classified' in THIS
      // transaction even on the conflict path, so the checkpoint is never
      // separable from the action's existence.
      await tx
        .update(schema.events)
        .set({ status: 'drafted', updatedAt: new Date() })
        .where(eq(schema.events.id, input.eventId));
      return {
        value: { actionId: existingId, drafterRunId: null },
        audit: {
          familyId: input.familyId,
          actor: 'system',
          actionTaken: 'action.drafted_duplicate_suppressed',
          targetTable: 'actions',
          targetId: existingId,
          after: { reason: 'action already drafted for event — redelivery suppressed' },
        },
      };
    }

    const actionId = inserted[0]?.id;
    if (!actionId) {
      throw new Error('action insert returned empty result on the non-conflict path');
    }

    const drafterRunId = await recordAgentRun(
      {
        familyId: input.familyId,
        eventId: input.eventId,
        actionId,
        metrics: input.drafterMetrics,
      },
      tx,
    );

    await tx
      .update(schema.actions)
      .set({ draftedByAgentRunId: drafterRunId })
      .where(eq(schema.actions.id, actionId));

    // FIX 2 atomic fold: the 'drafted' checkpoint commits WITH the action row,
    // so a crash can never leave an action persisted while the event is still
    // 'classified' (which would re-run the drafter on resume).
    await tx
      .update(schema.events)
      .set({ status: 'drafted', updatedAt: new Date() })
      .where(eq(schema.events.id, input.eventId));

    return {
      value: { actionId, drafterRunId },
      audit: {
        familyId: input.familyId,
        actor: drafterRunId,
        actionTaken: 'action.drafted',
        targetTable: 'actions',
        targetId: actionId,
        after: { actionType: input.actionType },
        agentRunId: drafterRunId,
      },
    };
  }, database);
}

export async function recordReviewerVerdict(
  input: RecordReviewerVerdictInput,
  database: Database = db(),
): Promise<void> {
  const verdictColumn =
    input.verdict.kind === 'approve'
      ? 'approved'
      : input.verdict.kind === 'reject'
        ? 'rejected'
        : 'flagged';

  await recordTransition(async (tx) => {
    const existing = await tx
      .select({ familyId: schema.actions.familyId })
      .from(schema.actions)
      .where(eq(schema.actions.id, input.actionId))
      .limit(1);
    const familyId = existing[0]?.familyId;
    if (!familyId) {
      throw new Error(`recordReviewerVerdict: action ${input.actionId} not found`);
    }

    await recordAgentRun(
      { familyId, actionId: input.actionId, metrics: input.reviewerMetrics },
      tx,
    );

    await tx
      .update(schema.actions)
      .set({
        reviewerVerdict: verdictColumn,
        reviewerVerdictAt: new Date(),
        reviewerToolResults: input.verdict.toolResults.map((r) => ({
          tool: r.tool,
          ok: r.ok,
          result: r.result,
        })),
        userVisibleState: input.verdict.kind === 'approve' ? 'drafted_for_approval' : 'needs_human',
      })
      .where(eq(schema.actions.id, input.actionId));

    return {
      value: undefined,
      audit: {
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
      },
    };
  }, database);
}

export async function recordExecution(
  input: RecordExecutionInput,
  database: Database = db(),
): Promise<void> {
  await recordTransition(async (tx) => {
    const existing = await tx
      .select({ familyId: schema.actions.familyId })
      .from(schema.actions)
      .where(eq(schema.actions.id, input.actionId))
      .limit(1);
    const familyId = existing[0]?.familyId;
    if (!familyId) {
      throw new Error(`recordExecution: action ${input.actionId} not found`);
    }

    await tx
      .update(schema.actions)
      .set({
        executedAt: new Date(),
        executorResult: input.result,
        userVisibleState: input.ok ? 'autonomous' : 'needs_human',
      })
      .where(eq(schema.actions.id, input.actionId));

    return {
      value: undefined,
      audit: {
        familyId,
        actor: 'system',
        actionTaken: input.ok ? 'action.executed' : 'action.execution_failed',
        targetTable: 'actions',
        targetId: input.actionId,
        after: { ...input.result, decision: input.decision },
      },
    };
  }, database);
}

/**
 * Records an orchestrator decision to NOT proceed with an event — the paths that
 * previously returned silently. Updates the event's status and writes the audit
 * row so PIPEDA right-to-access shows why nothing happened (hard rule #6).
 */
export async function recordDrop(input: RecordDropInput, database: Database = db()): Promise<void> {
  const actionTaken = `event.dropped.${input.reason}` as const;
  // unknown_action_type is an automated-handling failure; low_confidence and
  // needs_human are routed onward to the human queue. Both are existing
  // event_status values (no migration — hard rule #9).
  const status = input.reason === 'unknown_action_type' ? 'failed' : 'routed';
  await recordTransition(async (tx) => {
    await tx
      .update(schema.events)
      .set({ status, updatedAt: new Date() })
      .where(eq(schema.events.id, input.eventId));

    return {
      value: undefined,
      audit: {
        familyId: input.familyId,
        actor: 'system',
        actionTaken,
        targetTable: 'events',
        targetId: input.eventId,
        after: input.detail,
      },
    };
  }, database);
}

/**
 * Records a Reviewer non-approval (reject / flag_for_human) at the orchestrator
 * gate. recordReviewerVerdict already audited the verdict against the action;
 * this audits the orchestrator's routing decision (surfaced to user, not executed).
 */
export async function recordReviewerRejection(
  input: RecordReviewerRejectionInput,
  database: Database = db(),
): Promise<void> {
  await recordTransition(async (tx) => {
    await tx
      .update(schema.actions)
      .set({ userVisibleState: 'needs_human' })
      .where(eq(schema.actions.id, input.actionId));

    return {
      value: undefined,
      audit: {
        familyId: input.familyId,
        actor: 'system',
        actionTaken: 'action.surfaced_to_user',
        targetTable: 'actions',
        targetId: input.actionId,
        after: { verdict: input.verdictKind, rationale: input.rationale },
      },
    };
  }, database);
}

/**
 * The rule-#4 / #5 / teen structural gates that block autonomous execution but
 * leave the action at its drafted_for_approval default (surfaced to the user,
 * not executed). Each maps to a distinct audit action_taken so PIPEDA
 * right-to-access shows precisely which gate fired (hard rule #6).
 */
export type ActionGateReason =
  | 'observation_window'
  | 'streak'
  | 'cross_parent_consent'
  | 'teen_redaction'
  | 'autonomy_not_opted_in'
  | 'parent_commitment'
  | 'lane_off'
  | 'autonomy_denied_kind'
  | 'autonomy_notice_pending';

interface RecordActionGateInput {
  familyId: string;
  actionId: string;
  actionType: ActionType;
  reason: ActionGateReason;
  detail: Record<string, unknown>;
}

/**
 * Records a structural autonomy gate: an approved action that would have gone
 * autonomous, held back to drafted_for_approval by a rule-#4/#5/teen gate. The
 * action's domain state is already its drafted_for_approval default; this writes
 * the audit row (hard rule #6) with the distinct gate reason.
 */
export async function recordActionGate(
  input: RecordActionGateInput,
  database: Database = db(),
): Promise<void> {
  await recordTransition(async () => {
    return {
      value: undefined,
      audit: {
        familyId: input.familyId,
        actor: 'system',
        actionTaken: `action.gated.${input.reason}`,
        targetTable: 'actions',
        targetId: input.actionId,
        after: { actionType: input.actionType, ...input.detail },
      },
    };
  }, database);
}

// ─── B9: outbound idempotency claim ──────────────────────────────────────

/**
 * Claims the right to send for an action. Inserts an outbound_sends row;
 * `onConflictDoNothing` on the unique action_id means a redelivery (or a
 * concurrent worker) gets an empty result → false → the caller must NOT send.
 * Returns true only for the single pass that wins the claim.
 */
export async function claimOutboundSend(
  actionId: string,
  database: Database = db(),
): Promise<boolean> {
  const inserted = await database
    .insert(schema.outboundSends)
    .values({ actionId })
    .onConflictDoNothing({ target: schema.outboundSends.actionId })
    .returning({ id: schema.outboundSends.id });
  return inserted.length > 0;
}

/** Marks a claimed send as confirmed once the provider acknowledges it. */
export async function confirmOutboundSend(
  actionId: string,
  providerMessageId: string,
  database: Database = db(),
): Promise<void> {
  await database
    .update(schema.outboundSends)
    .set({ sentAt: new Date(), providerMessageId })
    .where(eq(schema.outboundSends.actionId, actionId));
}

/**
 * Audits a send that was skipped because the claim already existed (a
 * redelivery). The action's domain state is unchanged — only the audit trail
 * records that we refused to double-send (hard rule #6).
 */
export async function recordSendSkippedDuplicate(
  familyId: string,
  actionId: string,
  database: Database = db(),
): Promise<void> {
  await recordTransition(async () => {
    return {
      value: undefined,
      audit: {
        familyId,
        actor: 'system',
        actionTaken: 'action.send_skipped_duplicate',
        targetTable: 'actions',
        targetId: actionId,
        after: { reason: 'outbound_send already claimed — redelivery suppressed' },
      },
    };
  }, database);
}

// ─── B10: stage checkpoints + crash-resume ───────────────────────────────

/** Pipeline stages a re-delivered event may already have passed, plus the
 * terminal execution outcomes. 'approved_pending_execute' is the resumable
 * pre-executor checkpoint; 'actioned'/'failed' are written after the executor
 * runs so a 'reviewed'/'approved_pending_execute' status is never left dangling
 * once execution completes (FIX 1). */
export type StageCheckpoint =
  | 'classified'
  | 'drafted'
  | 'reviewed'
  | 'approved_pending_execute'
  | 'actioned'
  | 'failed';

export interface ResumePoint {
  eventId: string;
  status: string;
  eventType: EventType;
  payload: Record<string, unknown>;
  classifierConfidence: number;
  suggestion: ClassifierSuggestion | null;
  /** Persisted teen-content flag, so the resume path re-applies the rule-#1
   * teen-redaction cap with the same value the fresh pass saw (FIX 1). */
  teenContent: boolean;
}

/**
 * Looks up an already-processed event by its content hash. Returns the stored
 * classification so a retry can skip the (billable) classifier call and resume
 * from wherever the previous pass stopped — the B10 re-entrancy guarantee.
 */
export async function loadResumePoint(
  familyId: string,
  dedupHash: string,
  database: Database = db(),
): Promise<ResumePoint | null> {
  const rows = await database
    .select({
      id: schema.events.id,
      status: schema.events.status,
      eventType: schema.events.eventType,
      payload: schema.events.payload,
      classifierConfidence: schema.events.classifierConfidence,
      classifierSuggestion: schema.events.classifierSuggestion,
      teenContent: schema.events.teenContent,
    })
    .from(schema.events)
    .where(
      sql`${schema.events.familyId} = ${familyId} AND ${schema.events.dedupHash} = ${dedupHash}`,
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    eventId: row.id,
    status: row.status,
    eventType: row.eventType as EventType,
    payload: row.payload,
    classifierConfidence: row.classifierConfidence ?? 0,
    suggestion: row.classifierSuggestion as ClassifierSuggestion | null,
    teenContent: row.teenContent,
  };
}

/** Loads the most recent drafted action for an event, to resume from review. */
export async function loadActionForEvent(
  eventId: string,
  database: Database = db(),
): Promise<{ actionId: string; actionType: ActionType; payload: Record<string, unknown> } | null> {
  const rows = await database
    .select({
      id: schema.actions.id,
      actionType: schema.actions.actionType,
      payload: schema.actions.payload,
    })
    .from(schema.actions)
    .where(eq(schema.actions.eventId, eventId))
    .orderBy(sql`${schema.actions.draftedAt} DESC`)
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return { actionId: row.id, actionType: row.actionType as ActionType, payload: row.payload };
}

/**
 * Loads an action by its own id, with the fields the human-approve consumer
 * needs to decide whether it MAY be driven into execution: the current
 * user_visible_state (precondition: must be 'drafted_for_approval'), the stored
 * reviewer verdict (precondition: must be 'approved' with tool results), the
 * event id (so the executor's stage advance targets the right event), and the
 * action type + payload (to re-mint the ApprovedAction). Returns null when the
 * action does not exist; the consumer then logs and drops.
 */
export async function loadActionForApproval(
  actionId: string,
  database: Database = db(),
): Promise<{
  eventId: string;
  actionType: ActionType;
  payload: Record<string, unknown>;
  userVisibleState: string;
  verdict: ReviewerVerdict | null;
} | null> {
  const rows = await database
    .select({
      eventId: schema.actions.eventId,
      actionType: schema.actions.actionType,
      payload: schema.actions.payload,
      userVisibleState: schema.actions.userVisibleState,
      reviewerVerdict: schema.actions.reviewerVerdict,
      toolResults: schema.actions.reviewerToolResults,
    })
    .from(schema.actions)
    .where(eq(schema.actions.id, actionId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const verdict: ReviewerVerdict | null =
    row.reviewerVerdict === 'approved'
      ? {
          kind: 'approve',
          toolResults: row.toolResults.map((r) => ({ tool: r.tool, ok: r.ok, result: r.result })),
          rationale: 'human-approved from stored verdict',
        }
      : null;

  return {
    eventId: row.eventId,
    actionType: row.actionType as ActionType,
    payload: row.payload,
    userVisibleState: row.userVisibleState,
    verdict,
  };
}

/**
 * Loads a previously-recorded `approved` verdict for an action so a resume from
 * the 'approved_pending_execute' checkpoint can re-mint the ApprovedAction and
 * re-drive the executor (FIX 1). Returns null unless the persisted verdict is
 * 'approved'; the stored tool results carry the `ok` flags the coverage check
 * needs, so the re-mint is gated exactly as the original pass was.
 */
export async function loadApprovedVerdictForAction(
  actionId: string,
  database: Database = db(),
): Promise<ReviewerVerdict | null> {
  const rows = await database
    .select({
      verdict: schema.actions.reviewerVerdict,
      toolResults: schema.actions.reviewerToolResults,
    })
    .from(schema.actions)
    .where(eq(schema.actions.id, actionId))
    .limit(1);

  const row = rows[0];
  if (!row || row.verdict !== 'approved') return null;
  return {
    kind: 'approve',
    toolResults: row.toolResults.map((r) => ({ tool: r.tool, ok: r.ok, result: r.result })),
    rationale: 'resumed from stored approved verdict',
  };
}

/**
 * Loads a family's creation timestamp — drives the rule #4 7-day observe window.
 * A family younger than the window NEVER auto-executes.
 */
export async function loadFamilyCreatedAt(
  familyId: string,
  database: Database = db(),
): Promise<Date> {
  const rows = await database
    .select({ createdAt: schema.families.createdAt })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new Error(`loadFamilyCreatedAt: no family row for ${familyId}`);
  }
  return row.createdAt;
}

/**
 * Loads the family's children's names, so check_pii_leak can match
 * child_full_name leaks. Empty array when the family has no children rows yet —
 * the tool then reports names_unavailable (degraded, not silent).
 */
export async function loadChildNames(
  familyId: string,
  database: Database = db(),
): Promise<string[]> {
  const rows = await database
    .select({ name: schema.children.name })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));
  return rows.map((r) => r.name);
}

/**
 * The stage-aware context the orchestrator hands the classifier and the
 * teen-redaction cap. `stages` is the distinct per-child stages (empty when the
 * family has no children rows — the orchestrator defaults that to ['newborn']);
 * `contextSlice` is the disambiguation slice the classifier prompt expects.
 *
 * knownClinics/knownDaycares are deliberately absent: the schema has no
 * source-of-truth for them, so we omit rather than fabricate (the classifier
 * type marks them optional).
 */
export interface FamilyContext {
  stages: FamilyStage[];
  /** The family's known children, for child attribution. Empty when the family
   * has no children rows. The orchestrator validates the classifier's
   * concerns_child_id against these ids before persisting events.child_id. */
  children: Array<{ id: string; name: string; ageInMonths: number }>;
  contextSlice: {
    childrenAgesMonths: number[];
    province: string;
    timezone: string;
    /** Carried into the classifier so it can attribute a signal to a child by
     * name or age/stage cue. Omitted (undefined) when the family has no children
     * so the serialized slice for single-child/childless families is unchanged. */
    children?: Array<{ id: string; name: string; ageInMonths: number }>;
  };
}

/**
 * Loads everything stage-dependent for a family in one place: each child's
 * derived stage + age in months (from the children rows), the family's province,
 * and the primary parent's timezone. Deriving stage and age from the same
 * children query keeps them consistent and avoids a second round-trip. Stages
 * dedup naturally downstream via stagePackFor; ages are listed per child.
 */
export async function loadFamilyContext(
  familyId: string,
  database: Database = db(),
): Promise<FamilyContext> {
  const childRows = await database
    .select({
      id: schema.children.id,
      name: schema.children.name,
      dateOfBirth: schema.children.dateOfBirth,
    })
    .from(schema.children)
    .where(eq(schema.children.familyId, familyId));

  const familyRows = await database
    .select({ province: schema.families.provinceOrState })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  const family = familyRows[0];
  if (!family) {
    throw new Error(`loadFamilyContext: no family row for ${familyId}`);
  }

  const parentRows = await database
    .select({ timezone: schema.users.timezone })
    .from(schema.familyMembers)
    .innerJoin(schema.users, eq(schema.familyMembers.userId, schema.users.id))
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'primary_parent'),
      ),
    )
    .limit(1);

  const children = childRows.map((r) => ({
    id: r.id,
    name: r.name,
    ageInMonths: ageInMonths(r.dateOfBirth),
  }));

  return {
    stages: childRows.map((r) => deriveStage(r.dateOfBirth)),
    children,
    contextSlice: {
      childrenAgesMonths: children.map((c) => c.ageInMonths),
      province: family.province ?? '',
      timezone: parentRows[0]?.timezone ?? 'America/Toronto',
      // Only surfaced to the classifier when a family has more than one child —
      // attribution only matters with siblings, and omitting it for single-child
      // / childless families keeps their serialized context slice byte-identical
      // (the cached classifier eval is unaffected).
      ...(children.length > 1 ? { children } : {}),
    },
  };
}

/**
 * Resolves the rule-#5 cross-parent consent state for one action kind in a family.
 *
 *   hasCoParent — does a family_members row with role 'co_parent' exist? If not,
 *     this is a single-parent household and cross-parent actions may proceed
 *     (the rule's own carve-out).
 *   coParentConsentGranted — does a co-parent hold a live grant for THIS kind in THIS
 *     family (parentsWithLiveGrant)? A grant is per parent and per kind, so a
 *     co-parent's grant for one kind is never read as their consent to another.
 */
export async function loadCrossParentConsent(
  familyId: string,
  actionType: ActionType,
  database: Reader = db(),
): Promise<{ hasCoParent: boolean; coParentConsentGranted: boolean }> {
  const coParents = (await familyParents(familyId, database)).filter(
    (parent) => parent.role === 'co_parent',
  );
  if (coParents.length === 0) {
    return { hasCoParent: false, coParentConsentGranted: false };
  }

  const live = await parentsWithLiveGrant(familyId, actionType, database);
  return {
    hasCoParent: true,
    coParentConsentGranted: coParents.some((parent) => live.has(parent.userId)),
  };
}

/**
 * The users whose own grant for a kind is live in this family: rule #4's per-kind
 * autonomy consent, a consent_records row of type 'autonomous_action_class' scoped to
 * the kind, one per parent. Written by that parent's own approval when it completes
 * their streak (recordHumanApproval); switched off by either parent
 * (revokeAutonomyForKind).
 *
 * Read newest first. A switch-off ends every grant before it, whoever wrote it, so the
 * walk stops there. Above it, each user's newest row decides for them, and it counts
 * only when it was never revoked: both withdrawal conventions in this table (an
 * appended granted=false row, a revoked_at stamp on the grant) read as off. Rows that
 * share an instant sort the switch-off first, so a tie reads as off.
 */
async function parentsWithLiveGrant(
  familyId: string,
  actionType: ActionType,
  database: Reader,
): Promise<Set<string>> {
  const rows = await database
    .select({
      userId: schema.consentRecords.userId,
      granted: schema.consentRecords.granted,
      revokedAt: schema.consentRecords.revokedAt,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.familyId, familyId),
        eq(schema.consentRecords.consentType, 'autonomous_action_class'),
        eq(schema.consentRecords.consentScope, actionType),
      ),
    )
    .orderBy(
      desc(schema.consentRecords.grantedAt),
      asc(schema.consentRecords.granted),
      desc(schema.consentRecords.id),
    );

  const live = new Set<string>();
  const decided = new Set<string>();
  for (const row of rows) {
    if (!row.granted) break;
    if (decided.has(row.userId)) continue;
    decided.add(row.userId);
    if (row.revokedAt === null) live.add(row.userId);
  }
  return live;
}

/** One parent's standing for one action kind (rule #4). Hale may do the kind on its
 * own only when one parent holds both halves. */
export interface ParentAutonomyStanding {
  parentUserId: string;
  /** Their own approvals of the kind have reached the streak. */
  streakReached: boolean;
  /** Their own grant for the kind is live. */
  optedIn: boolean;
}

/**
 * Every parent's standing for one kind (Barton, 2026-10-12: grants are per parent, and
 * each parent's own approvals arm the kind). Someone who is not a parent of the family
 * has no standing, whatever they approved.
 */
export async function loadAutonomyStanding(
  familyId: string,
  actionType: ActionType,
  database: Reader = db(),
): Promise<ParentAutonomyStanding[]> {
  const parents = await familyParents(familyId, database);
  const live = await parentsWithLiveGrant(familyId, actionType, database);
  const standing: ParentAutonomyStanding[] = [];
  for (const parent of parents) {
    standing.push({
      parentUserId: parent.userId,
      streakReached: streakSatisfiesAutonomy(
        actionType,
        await loadActionApprovalHistory(
          familyId,
          actionType,
          parent.userId,
          database,
          live.has(parent.userId),
        ),
      ),
      optedIn: live.has(parent.userId),
    });
  }
  return standing;
}

/** One text per grant. The web sender and this delivery check share the key. */
export function autonomyArmedDedupeKey(consentRecordId: string): string {
  return `autonomy_armed:${consentRecordId}`;
}

/** One text per autonomous execution, for each parent who is owed it. */
export function autonomyActedDedupeKey(actionId: string, parentUserId: string): string {
  return `autonomy_acted:${actionId}:${parentUserId}`;
}

/** Statuses that mean the turn-on text has left, matching the channel ledger's sent set. */
const TURN_ON_DELIVERED_STATUSES = ['queued', 'sent', 'delivered'] as const;

/**
 * Whether every parent who currently holds both the streak and a live grant for
 * this kind has had their turn-on text delivered. A quiet-hours hold does not
 * count: its row carries no dedupe key. A kind covered inside a text whose own
 * row is a different grant counts once the sent audit names this grant. Hale
 * does not do the kind until this is true, including overnight.
 */
export async function autonomyTurnOnDelivered(
  familyId: string,
  actionType: ActionType,
  database: Reader = db(),
): Promise<boolean> {
  const standing = await loadAutonomyStanding(familyId, actionType, database);
  const holders = standing.filter((parent) => parent.streakReached && parent.optedIn);
  if (holders.length === 0) return false;

  const rows = await database
    .select({
      id: schema.consentRecords.id,
      userId: schema.consentRecords.userId,
      granted: schema.consentRecords.granted,
      revokedAt: schema.consentRecords.revokedAt,
    })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.familyId, familyId),
        eq(schema.consentRecords.consentType, 'autonomous_action_class'),
        eq(schema.consentRecords.consentScope, actionType),
      ),
    )
    .orderBy(
      desc(schema.consentRecords.grantedAt),
      asc(schema.consentRecords.granted),
      desc(schema.consentRecords.id),
    );

  const grantByParent = new Map<string, string>();
  const decided = new Set<string>();
  for (const row of rows) {
    if (!row.granted) break;
    if (decided.has(row.userId)) continue;
    decided.add(row.userId);
    if (row.revokedAt === null) grantByParent.set(row.userId, row.id);
  }

  const keys = holders.flatMap((parent) => {
    const grantId = grantByParent.get(parent.parentUserId);
    return grantId ? [autonomyArmedDedupeKey(grantId)] : [];
  });
  if (keys.length !== holders.length) return false;

  const delivered = await database
    .select({ dedupeKey: schema.channelMessages.dedupeKey })
    .from(schema.channelMessages)
    .where(
      and(
        inArray(schema.channelMessages.dedupeKey, keys),
        inArray(schema.channelMessages.status, [...TURN_ON_DELIVERED_STATUSES]),
      ),
    );
  const deliveredKeys = new Set(delivered.map((row) => row.dedupeKey));
  // A second kind covered by the same text has no channel row of its own.
  // The sent audit is written only after the provider accepts that text.
  if (deliveredKeys.size < keys.length) {
    const covered = await database
      .select({ after: schema.auditLog.after })
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.actionTaken, 'autonomy_armed_notice_sent'),
          inArray(sql`${schema.auditLog.after} ->> 'dedupeKey'`, keys),
        ),
      );
    for (const row of covered) {
      const key = (row.after as { dedupeKey?: unknown } | null)?.dedupeKey;
      if (typeof key === 'string') deliveredKeys.add(key);
    }
  }
  return keys.every((key) => deliveredKeys.has(key));
}

async function familyParents(
  familyId: string,
  database: Reader,
): Promise<Array<{ userId: string; role: string }>> {
  return database
    .select({ userId: schema.familyMembers.userId, role: schema.familyMembers.role })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        inArray(schema.familyMembers.role, ['primary_parent', 'co_parent']),
      ),
    );
}

/**
 * Whether any parent of this family has ever opted a kind into autonomous execution —
 * the condition for offering the coach's switch-off verb at all. A family that never
 * granted one has nothing Hale does on its own, so there is nothing to turn off.
 */
export async function familyHasAutonomyGrant(
  familyId: string,
  database: Database = db(),
): Promise<boolean> {
  const rows = await database
    .select({ id: schema.consentRecords.id })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.familyId, familyId),
        eq(schema.consentRecords.consentType, 'autonomous_action_class'),
        eq(schema.consentRecords.granted, true),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export type AutonomyRevocation =
  | { outcome: 'revoked'; consentRecordId: string }
  | { outcome: 'not_a_parent' };

/**
 * Turns Hale's autonomy off for ONE action kind (Barton, 2026-10-11: one parent
 * message in any wording), for the whole family: either parent's switch-off ends
 * every parent's grant for the kind. Appends a granted=false 'autonomous_action_class'
 * row scoped to the kind (the ledger parentsWithLiveGrant reads) and its audit row in
 * one transaction. The row takes the database's clock, the same one the grant takes,
 * so the two always sort in the order they were written. Reading the parent's intent
 * is the caller's job (an AI read of the message, never a keyword match); `evidence`
 * is the parent's words plus that reading, kept on the consent row as every
 * conversational consent is, and never copied into the audit row. Only a parent can
 * switch it off: anyone else is the named `not_a_parent`, with nothing written.
 */
export async function revokeAutonomyForKind(
  input: {
    familyId: string;
    actorUserId: string;
    kind: ActionType;
    policyVersion: string;
    evidence: Record<string, unknown>;
  },
  database: Database = db(),
): Promise<AutonomyRevocation> {
  const parents = await familyParents(input.familyId, database);
  if (!parents.some((p) => p.userId === input.actorUserId)) {
    logger.warn(
      { familyId: input.familyId, kind: input.kind },
      'memory-writer: autonomy switch-off from someone who is not a parent of this family — refused',
    );
    return { outcome: 'not_a_parent' };
  }

  return recordTransition(async (tx) => {
    const [row] = await tx
      .insert(schema.consentRecords)
      .values({
        familyId: input.familyId,
        userId: input.actorUserId,
        consentType: 'autonomous_action_class',
        consentScope: input.kind,
        granted: false,
        policyVersion: input.policyVersion,
        evidence: input.evidence,
      })
      .returning({ id: schema.consentRecords.id });
    if (!row) {
      throw new Error('revokeAutonomyForKind: consent_records insert returned no row');
    }
    return {
      value: { outcome: 'revoked' as const, consentRecordId: row.id },
      audit: {
        familyId: input.familyId,
        actor: input.actorUserId,
        actionTaken: 'autonomous_action_class.revoked',
        targetTable: 'consent_records',
        targetId: row.id,
        after: { consentType: 'autonomous_action_class', consentScope: input.kind },
      },
    };
  }, database);
}

/**
 * The parent whose approval claimed this action's execute checkpoint
 * (recordHumanApproval's `action.approved_by_human` row), or null when no parent
 * approved it — i.e. the checkpoint is Hale's own autonomous claim.
 */
export async function loadHumanApprover(
  actionId: string,
  database: Database = db(),
): Promise<string | null> {
  const rows = await database
    .select({ actor: schema.auditLog.actor })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.actionTaken, 'action.approved_by_human'),
        eq(schema.auditLog.targetTable, 'actions'),
        eq(schema.auditLog.targetId, actionId),
      ),
    )
    .limit(1);
  return rows[0]?.actor ?? null;
}

const HUMAN_APPROVAL_VERB = 'action.approved_by_human';
const HUMAN_DISMISSAL_VERB = 'action.declined_by_human';
const HUMAN_UNDO_VERB = 'action.reverted_by_human';
const AUTONOMY_REVOKED_VERB = 'autonomous_action_class.revoked';

/**
 * One parent's recent decisions about one action kind, most-recent-first, for the
 * rule #4 streak: each of their approvals of an action of that kind
 * (recordHumanApproval's `action.approved_by_human` row), each draft of that kind
 * they dismissed (the web decline's `action.declined_by_human` row), each action of
 * that kind they undid after Hale did it (the web undo's `action.reverted_by_human`
 * row), and each switch-off of the kind by either parent (revokeAutonomyForKind's
 * `autonomous_action_class.revoked` row). An approval is `humanApproved`; a dismissal,
 * an undo and a switch-off are not, so each ends the run and the streak restarts from
 * it. The other parent's approvals, dismissals, and undos of a parent-approved run
 * are theirs and are not in this history. An undo of a run Hale made on its own is
 * in it when this parent holds a live grant: that undo restarts every granted
 * parent's streak and writes no revoked consent row.
 * An action Hale ran on its own has no approval row and is not in it either: it
 * neither counts toward the streak nor breaks it, so autonomy can never bootstrap
 * itself and never disarms itself.
 *
 * Read per kind, and only as far back as the streak needs, so another kind's
 * decisions can never push this kind's approvals out of the window.
 */
async function loadActionApprovalHistory(
  familyId: string,
  actionType: ActionType,
  parentUserId: string,
  database: Reader,
  autonomousUndoBreaksGrantedParent: boolean,
): Promise<{ actionType: string; humanApproved: boolean }[]> {
  const actionsOfKind = database
    .select({ id: sql<string>`${schema.actions.id}::text` })
    .from(schema.actions)
    .where(and(eq(schema.actions.familyId, familyId), eq(schema.actions.actionType, actionType)));
  const ownDecisions = and(
    inArray(schema.auditLog.actionTaken, [
      HUMAN_APPROVAL_VERB,
      HUMAN_DISMISSAL_VERB,
      HUMAN_UNDO_VERB,
    ]),
    eq(schema.auditLog.actor, parentUserId),
    eq(schema.auditLog.targetTable, 'actions'),
    inArray(schema.auditLog.targetId, actionsOfKind),
  );
  const switchOff = and(
    eq(schema.auditLog.actionTaken, AUTONOMY_REVOKED_VERB),
    sql`${schema.auditLog.after}->>'consentScope' = ${actionType}`,
  );
  // An undo of a run Hale made on its own restarts every granted parent's streak,
  // whoever pressed undo. It does not revoke the grant. An undo of a run a parent
  // approved stays in `ownDecisions` and breaks only that parent's streak.
  const autonomousUndo = and(
    eq(schema.auditLog.actionTaken, HUMAN_UNDO_VERB),
    eq(schema.auditLog.targetTable, 'actions'),
    inArray(schema.auditLog.targetId, actionsOfKind),
    sql`exists (
      select 1 from audit_log executed
      where executed.family_id = ${schema.auditLog.familyId}
        and executed.action_taken = 'action.executed'
        and executed.target_table = 'actions'
        and executed.target_id = ${schema.auditLog.targetId}
        and executed.after -> 'decision' ->> 'source' = 'autonomous'
    )`,
  );
  const rows = await database
    .select({ actionTaken: schema.auditLog.actionTaken })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.familyId, familyId),
        autonomousUndoBreaksGrantedParent
          ? or(ownDecisions, switchOff, autonomousUndo)
          : or(ownDecisions, switchOff),
      ),
    )
    .orderBy(desc(schema.auditLog.occurredAt))
    .limit(AUTONOMY_STREAK_REQUIRED);

  return rows.map((r) => ({ actionType, humanApproved: r.actionTaken === HUMAN_APPROVAL_VERB }));
}

/**
 * What an approval did to its kind's autonomy, named for every way it can end. Only
 * `granted` wrote anything: a grant row under the approving parent and its audit row.
 */
export type AutonomyGrant =
  | { outcome: 'granted'; consentRecordId: string }
  /** The approver's own approvals of the kind have not reached the streak. */
  | { outcome: 'not_reached' }
  /** Booking, registration or paying: never autonomous, however many approvals. */
  | { outcome: 'denied_kind' }
  /** The approver's grant for the kind is already live. */
  | { outcome: 'already_on' }
  /** The approver is not a parent of this family. */
  | { outcome: 'not_a_parent' };

/**
 * What became of an approval-record attempt. `claimed: false` carries the event's
 * CURRENT status so the caller can tell the two unclaimed worlds apart:
 * 'approved_pending_execute' is a prior attempt's checkpoint (crash residue or a
 * concurrent delivery — resumable, the executor's own effect-level claims dedupe the
 * sends), and any terminal status means execution already finished (drop). A named
 * outcome either way, never a silent one (rule #11).
 */
export type HumanApprovalClaim =
  | { claimed: true; autonomy: AutonomyGrant }
  | { claimed: false; eventStatus: string | null };

/**
 * Records a human's explicit approval of a drafted action and advances the event
 * to the resumable 'approved_pending_execute' checkpoint in ONE transaction.
 *
 * THE UPDATE IS THE CLAIM (audit P1-4): it advances the event only FROM 'reviewed' —
 * the one status every producer of an approvable action parks the event at (the
 * orchestrator's non-execute outcomes, the web pipeline's recordVerdict, the inline
 * drafts) — and reads its own row count. Two deliveries of one approval cannot both
 * record it: the loser's UPDATE matches nothing, writes nothing (no second audit row
 * claiming the parent approved twice), and can never regress a terminal 'actioned'
 * event back to the checkpoint. Hand-rolled transaction rather than recordTransition
 * because the refused path must write NO audit row — there is no transition to record.
 *
 * The audit row's actor is the approving parent (not 'system'), so PIPEDA
 * right-to-access answers "which parent approved this" (the reason the
 * actions.approved contract carries approvedBy). Folding the checkpoint into the
 * same transaction means an approval is never recorded without the event being
 * staged for execution, and vice-versa.
 *
 * The same transaction writes the kind's autonomy grant when this approval completes
 * the approver's streak (grantAutonomyOnStreak), so the fifth approval and the grant it
 * earns are one fact, and what happened to the grant is named on the claim.
 * `policyVersion` is the policy text in force, recorded on that grant.
 */
export async function recordHumanApproval(
  input: {
    familyId: string;
    eventId: string;
    actionId: string;
    approvedBy: string;
    policyVersion: string;
  },
  database: Database = db(),
): Promise<HumanApprovalClaim> {
  return database.transaction(async (tx) => {
    const claimed = await tx
      .update(schema.events)
      .set({ status: 'approved_pending_execute', updatedAt: new Date() })
      .where(and(eq(schema.events.id, input.eventId), eq(schema.events.status, 'reviewed')))
      .returning({ id: schema.events.id });

    if (claimed.length === 0) {
      const rows = await tx
        .select({ status: schema.events.status })
        .from(schema.events)
        .where(eq(schema.events.id, input.eventId))
        .limit(1);
      return { claimed: false, eventStatus: rows[0]?.status ?? null };
    }

    await tx.insert(schema.auditLog).values({
      familyId: input.familyId,
      actor: input.approvedBy,
      actionTaken: 'action.approved_by_human',
      targetTable: 'actions',
      targetId: input.actionId,
      after: { approvedBy: input.approvedBy },
    });
    return { claimed: true, autonomy: await grantAutonomyOnStreak(tx, input) };
  });
}

/**
 * Rule #4's explicit per-kind consent, as Barton set it (2026-10-11, per parent
 * 2026-10-12): once a parent has approved a kind AUTONOMY_STREAK_REQUIRED times in a
 * row, Hale may do that kind on its own. Called inside recordHumanApproval's
 * transaction, after the approval's own audit row, so the streak it reads includes the
 * approval being recorded.
 *
 * Writes the row parentsWithLiveGrant reads, under the approving parent, plus its audit
 * row. A never-autonomous kind (booking, registration, paying) is never granted, and
 * neither is someone who is not a parent. After a switch-off the streak restarts from
 * it, so the next grant takes AUTONOMY_STREAK_REQUIRED new approvals.
 */
async function grantAutonomyOnStreak(
  tx: Tx,
  input: { familyId: string; actionId: string; approvedBy: string; policyVersion: string },
): Promise<AutonomyGrant> {
  const [action] = await tx
    .select({ actionType: schema.actions.actionType })
    .from(schema.actions)
    .where(eq(schema.actions.id, input.actionId))
    .limit(1);
  if (!action) {
    throw new Error(`grantAutonomyOnStreak: action ${input.actionId} not found`);
  }
  const kind = action.actionType as ActionType;
  if (autonomyDeniedForKind(kind)) return { outcome: 'denied_kind' };

  const approver = (await loadAutonomyStanding(input.familyId, kind, tx)).find(
    (parent) => parent.parentUserId === input.approvedBy,
  );
  if (!approver) return { outcome: 'not_a_parent' };
  if (!approver.streakReached) return { outcome: 'not_reached' };
  if (approver.optedIn) return { outcome: 'already_on' };

  const [row] = await tx
    .insert(schema.consentRecords)
    .values({
      familyId: input.familyId,
      userId: input.approvedBy,
      consentType: 'autonomous_action_class',
      consentScope: kind,
      granted: true,
      policyVersion: input.policyVersion,
    })
    .returning({ id: schema.consentRecords.id });
  if (!row) {
    throw new Error('grantAutonomyOnStreak: consent_records insert returned no row');
  }
  await tx.insert(schema.auditLog).values({
    familyId: input.familyId,
    actor: input.approvedBy,
    actionTaken: 'autonomous_action_class.granted',
    targetTable: 'consent_records',
    targetId: row.id,
    after: {
      consentType: 'autonomous_action_class',
      consentScope: kind,
      approvals: AUTONOMY_STREAK_REQUIRED,
    },
  });
  return { outcome: 'granted', consentRecordId: row.id };
}

/**
 * Checkpoints an event's pipeline progress after a stage completes, audited so
 * the resume path is provable. A crash between this write and the next stage
 * leaves the event at the last checkpoint — the retry reads it and skips ahead.
 */
export async function markEventStage(
  familyId: string,
  eventId: string,
  stage: StageCheckpoint,
  database: Database = db(),
): Promise<void> {
  await recordTransition(async (tx) => {
    await tx
      .update(schema.events)
      .set({ status: stage, updatedAt: new Date() })
      .where(eq(schema.events.id, eventId));

    return {
      value: undefined,
      audit: {
        familyId,
        actor: 'system',
        actionTaken: `event.stage.${stage}`,
        targetTable: 'events',
        targetId: eventId,
        after: { status: stage },
      },
    };
  }, database);
}

// ─── Memory graph: longitudinal family-context read path ──────────────────

/** How many most-recent episodes a memory slice carries to an agent. Bounded so
 * the slice that goes into a drafter prompt stays small. */
const MEMORY_SLICE_EPISODE_LIMIT = 20;

export interface MemorySlice {
  facts: schema.FamilyMemoryFact[];
  episodes: schema.FamilyMemoryEpisode[];
}

/**
 * Reads a family's current memory: every currently-valid fact (valid_until IS
 * NULL — the lookup index is partial on exactly this predicate) plus the most
 * recent episodes. This is the snapshot the drafter consults for context and the
 * inferencer diffs against. An empty family returns {facts:[],episodes:[]} — the
 * callers skip gracefully rather than null-masking.
 */
export async function getMemorySlice(
  familyId: string,
  database: Database = db(),
): Promise<MemorySlice> {
  const facts = await database
    .select()
    .from(schema.familyMemoryFacts)
    .where(
      and(
        eq(schema.familyMemoryFacts.familyId, familyId),
        sql`${schema.familyMemoryFacts.validUntil} IS NULL`,
      ),
    );

  const episodes = await database
    .select()
    .from(schema.familyMemoryEpisodes)
    .where(eq(schema.familyMemoryEpisodes.familyId, familyId))
    .orderBy(sql`${schema.familyMemoryEpisodes.occurredAt} DESC`)
    .limit(MEMORY_SLICE_EPISODE_LIMIT);

  return { facts, episodes };
}
