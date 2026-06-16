import { and, eq, inArray, sql } from 'drizzle-orm';
import { schema, type Database } from '@hale/db';
import type {
  EventType,
  ActionType,
  ReviewerVerdict,
  ClassifierSuggestion,
  PlanTier,
  Entitlement,
  FamilyStage,
} from '@hale/types';
import { ageInMonths, deriveStage } from '@hale/types';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import { db } from '../db.js';
import { logger } from '../logger.js';

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

interface RecordEntitlementGateInput {
  familyId: string;
  actionId: string;
  actionType: ActionType;
  planTier: PlanTier;
  requiredEntitlement: Entitlement;
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
    logger.debug({ familyId: input.familyId, eventId: existingId }, 'memory: duplicate event ignored');
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

  await recordTransition(
    async (tx) => {
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
    },
    database,
  );

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
        userVisibleState:
          input.verdict.kind === 'approve' ? 'drafted_for_approval' : 'needs_human',
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
        after: input.result,
      },
    };
  }, database);
}

/**
 * Records an orchestrator decision to NOT proceed with an event — the paths that
 * previously returned silently. Updates the event's status and writes the audit
 * row so PIPEDA right-to-access shows why nothing happened (hard rule #6).
 */
export async function recordDrop(
  input: RecordDropInput,
  database: Database = db(),
): Promise<void> {
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
 * Records the B18 entitlement gate: an approved action that would have gone
 * autonomous, blocked because the family's tier lacks the required entitlement.
 * The action stays at its drafted_for_approval default — drafting/review of paid
 * features is allowed on every tier; only autonomous EXECUTION is gated. The
 * audit `after` carries the upgrade hint for the UI to surface (hard rule #6).
 */
export async function recordEntitlementGate(
  input: RecordEntitlementGateInput,
  database: Database = db(),
): Promise<void> {
  await recordTransition(async () => {
    return {
      value: undefined,
      audit: {
        familyId: input.familyId,
        actor: 'system',
        actionTaken: 'action.entitlement_gated',
        targetTable: 'actions',
        targetId: input.actionId,
        after: {
          actionType: input.actionType,
          planTier: input.planTier,
          requiredEntitlement: input.requiredEntitlement,
          upgradeHint:
            input.requiredEntitlement === 'autonomy_l3'
              ? 'Upgrade to Plus to let Hale act autonomously.'
              : 'Upgrade to Family to let Hale act autonomously on commerce and portal actions.',
        },
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
  | 'over_allowance';

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

/** Loads a family's billing tier — drives the B18 entitlement gate on autonomy. */
export async function loadFamilyPlanTier(
  familyId: string,
  database: Database = db(),
): Promise<PlanTier> {
  const rows = await database
    .select({ planTier: schema.families.planTier })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    throw new Error(`loadFamilyPlanTier: no family row for ${familyId}`);
  }
  return row.planTier;
}

/**
 * Sums a family's month-to-date LLM spend (USD) — drives the per-child fairness
 * valve (over-allowance autonomy gate). Sums `agent_runs.cost_usd` for runs
 * STARTED on/after the first of the current month; the `agent_runs_family_cost_idx`
 * (family_id, started_at, cost_usd) serves this scan. `cost_usd` is a numeric
 * column that Postgres SUMs as text, and is null for runs that recorded no cost,
 * so COALESCE(SUM(...), 0) and a Number() parse give a plain USD float. The month
 * boundary is computed in the DB's clock (now()) to match `started_at`.
 */
export async function loadFamilyMonthToDateCostUsd(
  familyId: string,
  database: Database = db(),
): Promise<number> {
  const rows = await database
    .select({
      total: sql<string>`COALESCE(SUM(${schema.agentRuns.costUsd}), 0)`,
    })
    .from(schema.agentRuns)
    .where(
      sql`${schema.agentRuns.familyId} = ${familyId} AND ${schema.agentRuns.startedAt} >= date_trunc('month', now())`,
    );

  return Number(rows[0]?.total ?? 0);
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
 * Resolves the rule-#5 cross-parent consent state for a family.
 *
 *   hasCoParent — does a family_members row with role 'co_parent' exist? If not,
 *     this is a single-parent household and cross-parent actions may proceed
 *     (the rule's own carve-out).
 *   coParentConsentGranted — is there an active (granted, not revoked)
 *     consent_records row of type 'autonomous_action_class' for that co-parent?
 *     That is the consent that authorizes Hale to act autonomously on the shared
 *     family data the co-parent's account contributes.
 */
export async function loadCrossParentConsent(
  familyId: string,
  database: Database = db(),
): Promise<{ hasCoParent: boolean; coParentConsentGranted: boolean }> {
  const coParents = await database
    .select({ userId: schema.familyMembers.userId })
    .from(schema.familyMembers)
    .where(
      and(
        eq(schema.familyMembers.familyId, familyId),
        eq(schema.familyMembers.role, 'co_parent'),
      ),
    );

  if (coParents.length === 0) {
    return { hasCoParent: false, coParentConsentGranted: false };
  }

  const coParentIds = coParents.map((r) => r.userId);
  const consents = await database
    .select({ userId: schema.consentRecords.userId })
    .from(schema.consentRecords)
    .where(
      and(
        eq(schema.consentRecords.consentType, 'autonomous_action_class'),
        eq(schema.consentRecords.granted, true),
        sql`${schema.consentRecords.revokedAt} IS NULL`,
        inArray(schema.consentRecords.userId, coParentIds),
      ),
    )
    .limit(1);

  return { hasCoParent: true, coParentConsentGranted: consents.length > 0 };
}

/**
 * Loads a family's recent action approval history, most-recent-first, for the
 * rule #4 per-action-type streak gate.
 *
 * "human-approved completion" derivation (from the actions schema): an action
 * that was approved at review (reviewer_verdict = 'approved'), then EXECUTED
 * (executed_at IS NOT NULL), and whose final user_visible_state is NOT
 * 'autonomous'. recordExecution stamps user_visible_state='autonomous' for
 * actions Hale ran on its own; the human-approval path (a parent approving a
 * drafted_for_approval action in the product UI) executes the same action
 * WITHOUT that autonomous marker. Excluding 'autonomous' is what makes a streak
 * count consecutive HUMAN approvals, not Hale's own prior auto-executions —
 * otherwise autonomy would bootstrap itself. With no human-approval write path
 * shipped yet, this returns zero qualifying rows, so every streak is 0 and L3
 * stays dark by default (correct per rule #4).
 */
export async function loadActionApprovalHistory(
  familyId: string,
  limit = 50,
  database: Database = db(),
): Promise<{ actionType: string; humanApproved: boolean }[]> {
  const rows = await database
    .select({
      actionType: schema.actions.actionType,
      verdict: schema.actions.reviewerVerdict,
      executedAt: schema.actions.executedAt,
      userVisibleState: schema.actions.userVisibleState,
    })
    .from(schema.actions)
    .where(eq(schema.actions.familyId, familyId))
    .orderBy(sql`${schema.actions.executedAt} DESC NULLS LAST`)
    .limit(limit);

  return rows
    .filter((r) => r.executedAt !== null)
    .map((r) => ({
      actionType: r.actionType,
      humanApproved: r.verdict === 'approved' && r.userVisibleState !== 'autonomous',
    }));
}

/**
 * Records a human's explicit approval of a drafted action and advances the event
 * to the resumable 'approved_pending_execute' checkpoint in ONE transaction.
 *
 * The audit row's actor is the approving parent (not 'system'), so PIPEDA
 * right-to-access answers "which parent approved this" (the reason the
 * actions.approved contract carries approvedBy). Folding the checkpoint into the
 * same transaction means an approval is never recorded without the event being
 * staged for execution, and vice-versa.
 */
export async function recordHumanApproval(
  input: { familyId: string; eventId: string; actionId: string; approvedBy: string },
  database: Database = db(),
): Promise<void> {
  await recordTransition(async (tx) => {
    await tx
      .update(schema.events)
      .set({ status: 'approved_pending_execute', updatedAt: new Date() })
      .where(eq(schema.events.id, input.eventId));

    return {
      value: undefined,
      audit: {
        familyId: input.familyId,
        actor: input.approvedBy,
        actionTaken: 'action.approved_by_human',
        targetTable: 'actions',
        targetId: input.actionId,
        after: { approvedBy: input.approvedBy },
      },
    };
  }, database);
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

// ─── Village: discovery + routine persistence ────────────────────────────

/** One discovered candidate to persist. The `kind` is supplied by the caller
 * (the discovery scheduler), since a provider's `DiscoveredCandidate` models an
 * activity without a category column. */
export interface DiscoveryCandidateWrite {
  title: string;
  kind: string;
  summary: string;
  sourceUrl?: string;
  source: string;
  confidence: number;
  coverageNote?: string;
  /** Null = family-wide; otherwise the attributed child (already validated). */
  childId: string | null;
}

/**
 * Persists a discovery run's candidates and ONE audit row in a single
 * transaction (hard rule #6: no village_candidates row without its audit trail).
 * A run with no candidates writes nothing — there is no transition to audit.
 *
 * Privacy (rule #1): the audit `after` carries only the coarse area, provider,
 * and a count — never a child name, DOB, or any candidate's raw text.
 */
export async function recordDiscovery(
  input: {
    familyId: string;
    areaCoarse: string;
    provider: string;
    candidates: DiscoveryCandidateWrite[];
  },
  database: Database = db(),
): Promise<{ insertedCount: number }> {
  if (input.candidates.length === 0) {
    return { insertedCount: 0 };
  }
  return recordTransition<{ insertedCount: number }>(async (tx) => {
    await tx.insert(schema.villageCandidates).values(
      input.candidates.map((c) => ({
        familyId: input.familyId,
        childId: c.childId,
        title: c.title,
        kind: c.kind,
        summary: c.summary,
        sourceUrl: c.sourceUrl,
        source: c.source,
        confidence: c.confidence,
        coverageNote: c.coverageNote,
      })),
    );
    return {
      value: { insertedCount: input.candidates.length },
      audit: {
        familyId: input.familyId,
        actor: 'system',
        actionTaken: 'village.discovery.recorded',
        targetTable: 'village_candidates',
        after: {
          areaCoarse: input.areaCoarse,
          provider: input.provider,
          count: input.candidates.length,
        },
      },
    };
  }, database);
}

/**
 * Upserts a family's weekly routine proposal and ONE audit row in a single
 * transaction (hard rule #6). The unique (family_id, week_of) index folds a
 * re-run into the same week's row rather than duplicating it, so a redelivered
 * discovery job recomputes the same proposal.
 *
 * Privacy (rule #1): the audit `after` carries only the week and item count —
 * never a child name, DOB, or item text.
 */
export async function recordRoutineProposal(
  input: {
    familyId: string;
    weekOf: string;
    items: Array<{ title: string; kind: string; childId: string | null; stageNote: string }>;
  },
  database: Database = db(),
): Promise<{ proposalId: string }> {
  return recordTransition<{ proposalId: string }>(async (tx) => {
    const upserted = await tx
      .insert(schema.routineProposals)
      .values({ familyId: input.familyId, weekOf: input.weekOf, items: input.items })
      .onConflictDoUpdate({
        target: [schema.routineProposals.familyId, schema.routineProposals.weekOf],
        set: { items: input.items },
      })
      .returning({ id: schema.routineProposals.id });

    const proposalId = upserted[0]?.id;
    if (!proposalId) {
      throw new Error('routine_proposals upsert returned no row');
    }
    return {
      value: { proposalId },
      audit: {
        familyId: input.familyId,
        actor: 'system',
        actionTaken: 'village.routine.recorded',
        targetTable: 'routine_proposals',
        targetId: proposalId,
        after: { weekOf: input.weekOf, itemCount: input.items.length },
      },
    };
  }, database);
}
