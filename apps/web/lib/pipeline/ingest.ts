import { type AgentClient, HAIKU_MODEL, SONNET_MODEL } from '@hale/agent';
import { type Database, schema } from '@hale/db';
import { type ActionType, deriveStage } from '@hale/types';
import { and, eq } from 'drizzle-orm';
import { traceAgentRun } from '~/lib/telemetry/langfuse';
import { classifyEvent } from './classify';
import { draftAction } from './draft';
import { dedupHashFor, recordDraft, recordEvent, recordVerdict, writeAutonomyGate } from './record';
import { reviewAction } from './review';

/**
 * The inbound event pipeline, Vercel-native (no worker): classify → draft →
 * review → store a pending-approval draft. It is the web-side mirror of the
 * worker's runOrchestrator, with one DELIBERATE difference that is the whole point
 * of this engine: it NEVER executes an external side-effect. Every path
 * terminates at an action in `drafted_for_approval` for a parent to approve
 * (rule #4 — new families are L1 observe-only for 7 days; no autonomous action
 * without explicit per-action-type consent). Execution is a separate, already-built
 * path: the parent's /api/actions/:id/approve → actions.approved → worker.
 *
 * Routing mirrors the worker: a confidence floor, the classifier's suggestion, and
 * a known-action-type guard decide whether a draft is even produced. Surface-only /
 * ignore / needs-human / low-confidence signals are recorded as events and stop —
 * they are digest material, not actions.
 *
 * Every stage records a cost-bearing agent_runs row and an immutable audit_log row
 * (rule #6); every read/write is family-scoped (rule #1). The Anthropic client is
 * injected so tests drive the loop mechanics with a fake (rule #8).
 */

const CONFIDENCE_HUMAN_THRESHOLD = 0.7;

/** New families are L1 observe-only for their first 7 days (hard rule #4). The
 * window is `< 7 days` old; a family created exactly 7 days ago has cleared it. */
const OBSERVATION_WINDOW_DAYS = 7;

function withinObservationWindow(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() < OBSERVATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

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
  'add_to_routine',
]);

export interface IngestInput {
  familyId: string;
  source: string;
  subject: string;
  body: string;
  /** Any extra normalized fields the provider supplied — carried into the
   * classifier's raw content verbatim. */
  extra?: Record<string, unknown>;
}

export type IngestOutcome =
  | { status: 'duplicate'; eventId: string }
  | { status: 'surfaced_only'; eventId: string; eventType: string }
  | { status: 'drafted_for_approval'; eventId: string; actionId: string; verdict: string }
  | { status: 'dropped'; eventId: string; reason: string };

export async function ingestEvent(
  input: IngestInput,
  database: Database,
  client: AgentClient,
  now: Date = new Date(),
): Promise<IngestOutcome> {
  const familyId = input.familyId;
  const rawContent = JSON.stringify({
    subject: input.subject,
    body: input.body,
    ...(input.extra ?? {}),
  });
  const dedupHash = dedupHashFor(familyId, input.source, rawContent);

  // 1. Classify (Haiku skill). Traced as 'classify-event'; the mask is the rule-#1
  // backstop over the inbound raw content the classifier sees.
  const { classified, classifyTraceId } = await traceAgentRun(
    { name: 'classify-event', userId: 'system', tags: ['classify-event'], metadata: { familyId } },
    async (trace) => {
      const result = await classifyEvent({ source: input.source, rawContent }, client);
      trace.recordGeneration('classify-event-call', { model: HAIKU_MODEL, usage: result.usage });
      return { classified: result, classifyTraceId: trace.traceId };
    },
  );

  // Validate child attribution against THIS family's children before persisting a
  // reference: a hallucinated/stale/cross-family id is dropped to null (rule #1 —
  // no dangling cross-family reference), exactly as the worker orchestrator does.
  const concernsChild = classified.concernsChildId
    ? await resolveFamilyChild(database, classified.concernsChildId, familyId)
    : null;
  const childId = concernsChild?.id ?? null;
  // Rule #1 write-site backstop: the classifier's teen_content is a probabilistic
  // signal, never the sole gate. When the event resolves to a child whose DOB makes
  // them a teenager (deriveStage boundary 156mo), the stored flag is OR'd to true —
  // so a classify miss can't leak a teen's raw content to the mask/surfaces that
  // read this flag.
  const teenContent =
    classified.teenContent ||
    (concernsChild !== null && deriveStage(concernsChild.dateOfBirth, now) === 'teenager');

  const recorded = await recordEvent(database, {
    familyId,
    source: input.source,
    eventType: classified.eventType,
    payload: classified.payload,
    classifierConfidence: classified.confidence,
    dedupHash,
    suggestion: classified.suggestion,
    teenContent,
    childId,
    usage: classified.usage,
    model: HAIKU_MODEL,
    langfuseTraceId: classifyTraceId,
  });

  if (recorded.duplicate) {
    return { status: 'duplicate', eventId: recorded.eventId };
  }
  const eventId = recorded.eventId;

  // 2. Route. Below the human floor, or a one-way / ignore / needs-human signal,
  // is digest material — recorded as an event and stopped. No draft is produced.
  if (classified.confidence < CONFIDENCE_HUMAN_THRESHOLD) {
    return { status: 'dropped', eventId, reason: 'low_confidence' };
  }
  if (classified.suggestion.kind !== 'autonomous_action') {
    return { status: 'surfaced_only', eventId, eventType: classified.eventType };
  }

  const actionType = classified.suggestion.actionType as ActionType;
  if (!KNOWN_ACTION_TYPES.has(actionType)) {
    return { status: 'dropped', eventId, reason: 'unknown_action_type' };
  }

  // 3. Draft (Sonnet skill). Traced as 'draft-action'.
  const { drafted, draftTraceId } = await traceAgentRun(
    { name: 'draft-action', userId: 'system', tags: ['draft-action'], metadata: { familyId } },
    async (trace) => {
      const result = await draftAction(
        {
          familyId,
          event: { eventId, eventType: classified.eventType, payload: classified.payload },
          actionType,
        },
        client,
      );
      trace.recordGeneration('draft-action-call', { model: SONNET_MODEL, usage: result.usage });
      return { drafted: result, draftTraceId: trace.traceId };
    },
  );

  const { actionId } = await recordDraft(database, {
    familyId,
    eventId,
    draft: drafted.draft,
    usage: drafted.usage,
    model: SONNET_MODEL,
    langfuseTraceId: draftTraceId,
  });

  // 4. Review (the reviewer skill — MUST invoke verification tools, rule #3). The
  // verdict is persisted; the action stays drafted_for_approval whatever it is.
  // Traced as 'review-action'.
  const { reviewed, reviewTraceId } = await traceAgentRun(
    { name: 'review-action', userId: 'system', tags: ['review-action'], metadata: { familyId } },
    async (trace) => {
      const result = await reviewAction(
        { familyId, draft: { ...drafted.draft, id: actionId } },
        database,
        client,
      );
      trace.recordGeneration('review-action-loop', { model: SONNET_MODEL, usage: result.usage });
      return { reviewed: result, reviewTraceId: trace.traceId };
    },
  );

  await recordVerdict(database, {
    familyId,
    eventId,
    actionId,
    actionType,
    verdict: reviewed.verdict,
    usage: reviewed.usage,
    model: SONNET_MODEL,
    langfuseTraceId: reviewTraceId,
  });

  // Rule #4 evidence: the action is HELD for a parent regardless of verdict (this
  // engine never auto-executes). For an L1 family (< 7 days old) we additionally
  // write an observation-window gate audit, so the trail shows WHY autonomy stayed
  // dark — the same reason the worker records, surfaced here without acting.
  if (await isFamilyInObserveWindow(database, familyId, now)) {
    await writeAutonomyGate(database, {
      familyId,
      actionId,
      reason: 'observation_window',
      detail: { windowDays: OBSERVATION_WINDOW_DAYS },
    });
  }

  return {
    status: 'drafted_for_approval',
    eventId,
    actionId,
    verdict: reviewed.verdict.kind,
  };
}

/** Returns the child (id + DOB, for the rule-#1 teen derivation) iff it names a
 * real child of THIS family, else null. */
async function resolveFamilyChild(
  database: Database,
  childId: string,
  familyId: string,
): Promise<{ id: string; dateOfBirth: string } | null> {
  const rows = await database
    .select({ id: schema.children.id, dateOfBirth: schema.children.dateOfBirth })
    .from(schema.children)
    .where(and(eq(schema.children.id, childId), eq(schema.children.familyId, familyId)))
    .limit(1);
  return rows[0] ?? null;
}

async function isFamilyInObserveWindow(
  database: Database,
  familyId: string,
  now: Date,
): Promise<boolean> {
  const rows = await database
    .select({ createdAt: schema.families.createdAt })
    .from(schema.families)
    .where(eq(schema.families.id, familyId))
    .limit(1);
  const createdAt = rows[0]?.createdAt;
  // No family row → fail closed to the most restrictive state (observe-only).
  if (!createdAt) return true;
  return withinObservationWindow(createdAt, now);
}
