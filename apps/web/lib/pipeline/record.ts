import { createHash } from 'node:crypto';
import { type Database, schema } from '@hale/db';
import type { ActionType, DraftedAction, ReviewerVerdict } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { haikuCostUsd, recordAgentRun, sonnetCostUsd } from '~/lib/agent-run';

/**
 * The pipeline's deterministic DB writes — the web-side analogue of the worker's
 * memory-writer record* functions, but scoped to the DRAFT pipeline (this engine
 * never executes; see ingest.ts). Every transition writes an immutable audit_log
 * row (rule #6) and a cost-bearing agent_runs row, and every write is
 * family-scoped (rule #1).
 */

/** Stable (family_id, dedup_hash) key for an inbound signal — matches the
 * worker's dedupHashFor so a signal that arrives on both legs dedups. */
export function dedupHashFor(familyId: string, source: string, rawContent: string): string {
  return createHash('sha256').update(`${familyId}|${source}|${rawContent}`).digest('hex');
}

async function writeAudit(
  database: Database,
  entry: {
    familyId: string;
    actor: string;
    actionTaken: string;
    targetTable?: string;
    targetId?: string;
    after?: unknown;
  },
): Promise<void> {
  await database.insert(schema.auditLog).values({
    familyId: entry.familyId,
    actor: entry.actor,
    actionTaken: entry.actionTaken,
    targetTable: entry.targetTable ?? null,
    targetId: entry.targetId ?? null,
    after: entry.after ?? null,
  });
}

export interface RecordEventInput {
  familyId: string;
  source: string;
  eventType: string;
  payload: Record<string, unknown>;
  classifierConfidence: number;
  dedupHash: string;
  suggestion: import('@hale/types').ClassifierSuggestion;
  teenContent: boolean;
  childId: string | null;
  usage: { promptTokens: number; completionTokens: number };
  model: string;
  langfuseTraceId?: string | null;
}

export interface RecordEventResult {
  eventId: string;
  duplicate: boolean;
}

/**
 * Insert the classified event (status 'classified'), idempotent on
 * (family_id, dedup_hash): a re-delivered signal hits the unique index and we
 * return the existing row's id with duplicate:true — the caller skips the rest of
 * the pipeline rather than minting a second draft. Records the classifier
 * agent_run + an audit row for the classification.
 */
export async function recordEvent(
  database: Database,
  input: RecordEventInput,
): Promise<RecordEventResult> {
  const inserted = await database
    .insert(schema.events)
    .values({
      familyId: input.familyId,
      source: input.source,
      eventType: input.eventType,
      childId: input.childId,
      payload: input.payload,
      classifierSuggestion: input.suggestion,
      teenContent: input.teenContent,
      classifiedAt: new Date(),
      classifierConfidence: input.classifierConfidence,
      dedupHash: input.dedupHash,
      status: 'classified',
    })
    .onConflictDoNothing({ target: [schema.events.familyId, schema.events.dedupHash] })
    .returning({ id: schema.events.id });

  const newId = inserted[0]?.id;
  if (!newId) {
    const existing = await database
      .select({ id: schema.events.id })
      .from(schema.events)
      .where(
        and(
          eq(schema.events.familyId, input.familyId),
          eq(schema.events.dedupHash, input.dedupHash),
        ),
      )
      .limit(1);
    const existingId = existing[0]?.id;
    if (!existingId) {
      throw new Error('recordEvent: conflict on dedup_hash but no existing event found');
    }
    return { eventId: existingId, duplicate: true };
  }

  await recordAgentRun(database, {
    familyId: input.familyId,
    eventId: newId,
    agentName: 'classifier',
    modelUsed: input.model,
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    costUsd: haikuCostUsd(input.usage),
    status: 'completed',
    langfuseTraceId: input.langfuseTraceId,
  });

  await writeAudit(database, {
    familyId: input.familyId,
    actor: 'system',
    actionTaken: 'event.classified',
    targetTable: 'events',
    targetId: newId,
    after: { eventType: input.eventType, suggestion: input.suggestion },
  });

  return { eventId: newId, duplicate: false };
}

export interface RecordDraftInput {
  familyId: string;
  eventId: string;
  draft: DraftedAction;
  usage: { promptTokens: number; completionTokens: number };
  model: string;
  langfuseTraceId?: string | null;
}

/**
 * Insert the drafted action at its drafted_for_approval default (the pipeline's
 * terminal user-visible state — this engine never executes, rule #4), advance the
 * event to 'drafted', record the drafter agent_run, and audit. Idempotent on the
 * event (actions_event_idx unique): a re-drive returns the existing action id.
 */
export async function recordDraft(
  database: Database,
  input: RecordDraftInput,
): Promise<{ actionId: string }> {
  const draftRunId = await recordAgentRun(database, {
    familyId: input.familyId,
    eventId: input.eventId,
    agentName: 'drafter',
    modelUsed: input.model,
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    costUsd: sonnetCostUsd(input.usage),
    status: 'completed',
    langfuseTraceId: input.langfuseTraceId,
  });

  const inserted = await database
    .insert(schema.actions)
    .values({
      eventId: input.eventId,
      familyId: input.familyId,
      actionType: input.draft.actionType,
      payload: input.draft.payload,
      draftedByAgentRunId: draftRunId,
      userVisibleState: 'drafted_for_approval',
    })
    .onConflictDoNothing({ target: schema.actions.eventId })
    .returning({ id: schema.actions.id });

  let actionId = inserted[0]?.id;
  if (!actionId) {
    const existing = await database
      .select({ id: schema.actions.id })
      .from(schema.actions)
      .where(eq(schema.actions.eventId, input.eventId))
      .limit(1);
    actionId = existing[0]?.id;
    if (!actionId) {
      throw new Error('recordDraft: conflict on event but no existing action found');
    }
    return { actionId };
  }

  await database
    .update(schema.events)
    .set({ status: 'drafted', updatedAt: new Date() })
    .where(eq(schema.events.id, input.eventId));

  await writeAudit(database, {
    familyId: input.familyId,
    actor: 'system',
    actionTaken: 'action.drafted',
    targetTable: 'actions',
    targetId: actionId,
    after: { actionType: input.draft.actionType },
  });

  return { actionId };
}

const VERDICT_ENUM = {
  approve: 'approved',
  reject: 'rejected',
  flag_for_human: 'flagged',
} as const;

export interface RecordVerdictInput {
  familyId: string;
  eventId: string;
  actionId: string;
  actionType: ActionType;
  verdict: ReviewerVerdict;
  usage: { promptTokens: number; completionTokens: number };
  model: string;
  langfuseTraceId?: string | null;
}

/**
 * Persist the reviewer verdict + its tool results onto the action, advance the
 * event to 'reviewed', record the reviewer agent_run, and audit. The action stays
 * at drafted_for_approval regardless of verdict — even an approve means "Hale may
 * NOT act on its own; a parent must approve" in this draft pipeline (rule #4).
 */
export async function recordVerdict(
  database: Database,
  input: RecordVerdictInput,
): Promise<void> {
  await recordAgentRun(database, {
    familyId: input.familyId,
    eventId: input.eventId,
    actionId: input.actionId,
    agentName: 'reviewer',
    modelUsed: input.model,
    promptTokens: input.usage.promptTokens,
    completionTokens: input.usage.completionTokens,
    costUsd: sonnetCostUsd(input.usage),
    status: 'completed',
    langfuseTraceId: input.langfuseTraceId,
  });

  await database
    .update(schema.actions)
    .set({
      reviewerVerdict: VERDICT_ENUM[input.verdict.kind],
      reviewerVerdictAt: new Date(),
      reviewerToolResults: input.verdict.toolResults,
    })
    .where(eq(schema.actions.id, input.actionId));

  await database
    .update(schema.events)
    .set({ status: 'reviewed', updatedAt: new Date() })
    .where(eq(schema.events.id, input.eventId));

  await writeAudit(database, {
    familyId: input.familyId,
    actor: 'system',
    actionTaken: `action.reviewed.${input.verdict.kind}`,
    targetTable: 'actions',
    targetId: input.actionId,
    after: { verdict: input.verdict.kind, rationale: input.verdict.rationale },
  });
}

/**
 * Audit-only record of the HARD monthly LLM-cost ceiling short-circuit: the
 * pipeline stopped BEFORE the classifier ran because the family is far past its
 * budget (the runaway breaker, distinct from the soft over-allowance valve). No
 * event row exists — the classifier never fired — so the audit is family-scoped
 * (targets `families`), mirroring the worker's event.dropped.spend_ceiling
 * without acting. Immutable audit row per rule #6.
 */
export async function writeSpendCeilingDrop(
  database: Database,
  input: { familyId: string; detail: Record<string, unknown> },
): Promise<void> {
  await writeAudit(database, {
    familyId: input.familyId,
    actor: 'system',
    actionTaken: 'event.dropped.spend_ceiling',
    targetTable: 'families',
    targetId: input.familyId,
    after: input.detail,
  });
}

/**
 * Audit-only record that an autonomy gate held the action back (rule #4). The
 * pipeline never executes, so the action is already at drafted_for_approval; this
 * row makes the REASON observable on the trail (e.g. the 7-day observe window),
 * mirroring the worker's action.gated.* audits without acting.
 */
export async function writeAutonomyGate(
  database: Database,
  input: { familyId: string; actionId: string; reason: string; detail: Record<string, unknown> },
): Promise<void> {
  await writeAudit(database, {
    familyId: input.familyId,
    actor: 'system',
    actionTaken: `action.gated.${input.reason}`,
    targetTable: 'actions',
    targetId: input.actionId,
    after: input.detail,
  });
}
