import { logger } from '../logger.js';
import { runClassifier } from '../agents/classifier.js';
import { runDrafter } from '../agents/drafter.js';
import { runReviewer } from '../agents/reviewer.js';
import { dedupHashFor } from '../agents/dedup.js';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import { runExecutor } from '../services/executor.js';
import {
  recordEvent,
  recordAction,
  recordReviewerVerdict,
  recordExecution,
  recordDrop,
  recordReviewerRejection,
  recordEntitlementGate,
  recordActionGate,
  loadResumePoint,
  loadActionForEvent,
  loadActionForApproval,
  loadApprovedVerdictForAction,
  loadFamilyPlanTier,
  loadFamilyCreatedAt,
  loadFamilyMonthToDateCostUsd,
  loadActionApprovalHistory,
  loadCrossParentConsent,
  loadFamilyContext,
  getMemorySlice,
  markEventStage,
  recordHumanApproval,
} from '../services/memory-writer.js';
import {
  mintApprovedAction,
  hasEntitlement,
  entitlementRequiredFor,
  isOverAllowance,
  monthlyAllowanceUsd,
  stageFromAgeInMonths,
  type DraftedAction,
  type ApprovedAction,
  type ActionType,
  type FamilyStage,
} from '@hale/types';
import {
  coverageSatisfiedWithResults,
  isCrossParentActionType,
  type IngestedEventPayload,
} from '@hale/tools-contracts';
import {
  withinObservationWindow,
  streakSatisfiesAutonomy,
  teenRedactionCapApplies,
} from './autonomy-gate.js';

const CONFIDENCE_AUTONOMY_THRESHOLD = 0.85;
const CONFIDENCE_HUMAN_THRESHOLD = 0.7;

// An accepted village item is a KNOWN, user-initiated intent — the parent tapped
// "accept" on a surfaced activity. It must NOT be re-derived by the probabilistic
// classifier (which has no add_to_routine instruction and routes activity notices
// to surface_only → dropped). source='village' + this marker short-circuits the
// classify stage with a deterministic add_to_routine suggestion, then runs the
// rest of the spine (draft → reviewer → autonomy gates → drafted_for_approval)
// unchanged. Mirrors the accept-flow contract in apps/web/lib/village/accept.ts.
const VILLAGE_SOURCE = 'village';
const VILLAGE_ACCEPT_EVENT_TYPE = 'activity_signup_open' as const;

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

/**
 * Deterministic workflow runner. Spec §1.3 — Orchestrator has no LLM
 * calls of its own; it routes jobs through the LLM agents and
 * deterministic services in sequence and records everything.
 *
 * The job shape is the shared `events.ingested` contract
 * (`IngestedEventPayload`), validated by the consumer before this runs.
 */
/** What the classify stage yields, whether fresh or replayed from a checkpoint. */
interface ClassifiedState {
  eventId: string;
  eventType: import('@hale/types').EventType;
  payload: Record<string, unknown>;
  confidence: number;
  suggestion: import('@hale/types').ClassifierSuggestion;
  /** Teen-content flag from the classifier, persisted on the event (FIX 1) so a
   * crash-resume re-applies the rule-#1 teen-redaction cap with the same value
   * the fresh pass saw. The cap is live on both the fresh and resume paths. */
  teenContent: boolean;
}

/** The classify-stage output the fresh path consumes — produced by the LLM
 * classifier OR, for an accepted village item, deterministically. */
type FreshClassification = Awaited<ReturnType<typeof runClassifier>>;

/**
 * Deterministic classify for an accepted village item (hard-known intent). No
 * LLM call: the suggestion is fixed to add_to_routine at full confidence and the
 * dedupHash matches the live classifier's so a re-accept of the same candidate
 * still dedups. The event payload is the accepted candidate's already-coarse
 * fields (rule #1 — no precise location ever reaches here). teen_content is false
 * (an activity signup is not teen-personal content) and child attribution is null
 * (the accept payload carries no child id).
 */
function classifyAcceptedVillageItem(job: IngestedEventPayload): FreshClassification {
  return {
    eventType: VILLAGE_ACCEPT_EVENT_TYPE,
    payload: job.payload,
    confidence: { score: 1, rationale: 'accepted village item — deterministic add_to_routine' },
    suggestion: { kind: 'autonomous_action', actionType: 'add_to_routine' },
    teenContent: false,
    concernsChildId: null,
    dedupHash: dedupHashFor(job.family_id, job.source, JSON.stringify(job.payload)),
    runMetrics: {
      agentName: 'classifier',
      modelUsed: 'deterministic',
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      latencyMs: 0,
    },
  };
}

export async function runOrchestrator(job: IngestedEventPayload): Promise<void> {
  const familyId = job.family_id;
  const rawContent = JSON.stringify(job.payload);
  const dedupHash = dedupHashFor(familyId, job.source, rawContent);
  logger.debug({ familyId, source: job.source }, 'orchestrator: start');

  // B10 checkpoint/resume: probe by content hash BEFORE the billable classify
  // call. A crash-and-retry reads the stored classification and skips ahead;
  // the classifier never fires twice for the same signal.
  const resume = await loadResumePoint(familyId, dedupHash);

  // Terminal stages: a prior pass already finished routing this event. 'reviewed'
  // is terminal here because it now marks ONLY non-execute outcomes (rejection,
  // entitlement gate, below-autonomy-threshold) — an action that qualified for
  // autonomous execution is checkpointed at 'approved_pending_execute' instead,
  // which is RESUMABLE below (FIX 1).
  if (resume && ['reviewed', 'routed', 'actioned', 'ignored', 'failed'].includes(resume.status)) {
    logger.debug(
      { familyId, eventId: resume.eventId, status: resume.status },
      'orchestrator: event already terminal on a prior pass — nothing to resume',
    );
    return;
  }

  // FIX 1 resume: a prior pass approved + autonomy-qualified the action and
  // checkpointed it, then crashed before (or during) the executor send. Re-drive
  // the executor exactly once — the outbound_sends claim dedups a true
  // double-send — and advance the event to its terminal outcome. The rule-#1
  // teen-redaction cap is re-applied inside resumeIntoExecutor using the
  // persisted teen_content, so an autonomous-eligible teen-content action that
  // crashed at the checkpoint is still capped on resume (never reaches executor).
  if (resume && resume.status === 'approved_pending_execute') {
    await resumeIntoExecutor(familyId, resume.eventId, resume.teenContent);
    return;
  }

  // Stage-aware family context, loaded once and reused: the classifier reads
  // the context slice + stages (so a teenager family gets the teenager pack, not
  // the default newborn pack), and the rule-#1 teen-redaction cap below reads the
  // same stages. Empty children → ['newborn'] (the conservative default).
  const familyContext = await loadFamilyContext(familyId);
  const stages: FamilyStage[] =
    familyContext.stages.length > 0 ? familyContext.stages : ['newborn'];

  // 1. Classify — skipped on resume, loaded from the checkpointed event instead.
  let classified: ClassifiedState;
  if (resume) {
    if (!resume.suggestion) {
      throw new Error(
        `orchestrator: event ${resume.eventId} checkpointed at '${resume.status}' without a stored suggestion — cannot resume routing`,
      );
    }
    logger.info(
      { familyId, eventId: resume.eventId, status: resume.status },
      'orchestrator: resuming from stored classification (classifier NOT re-run)',
    );
    classified = {
      eventId: resume.eventId,
      eventType: resume.eventType,
      payload: resume.payload,
      confidence: resume.classifierConfidence,
      suggestion: resume.suggestion,
      teenContent: resume.teenContent,
    };
  } else {
    const isAcceptedVillageItem =
      job.source === VILLAGE_SOURCE && job.payload.event_type === VILLAGE_ACCEPT_EVENT_TYPE;
    const fresh = isAcceptedVillageItem
      ? classifyAcceptedVillageItem(job)
      : await runClassifier({
          familyId,
          source: job.source,
          rawContent,
          stages,
          familyContextSlice: familyContext.contextSlice,
        });
    // Child attribution: trust the classifier's concerns_child_id ONLY if it
    // names a real child of this family — a hallucinated or stale id is dropped
    // to null rather than written as a dangling reference. events.child_id is
    // additive + nullable, so null (undeterminable or family-wide) is fine.
    const knownChild =
      fresh.concernsChildId
        ? familyContext.children.find((c) => c.id === fresh.concernsChildId)
        : undefined;
    const childId = knownChild?.id ?? null;
    // Rule #1 write-site backstop: the classifier's teen_content is a probabilistic
    // signal, never the sole gate. When the event resolves to a known child whose
    // age makes them a teenager (deriveStage boundary 156mo, via stageFromAgeInMonths
    // on the age already loaded here), the stored flag is OR'd to true — so a
    // classify miss can't leak a teen's raw content to the mask/autonomy cap that
    // read this flag.
    const teenContent =
      fresh.teenContent ||
      (knownChild !== undefined && stageFromAgeInMonths(knownChild.ageInMonths) === 'teenager');
    const { eventId, duplicate } = await recordEvent({
      familyId,
      source: job.source,
      eventType: fresh.eventType,
      payload: fresh.payload,
      classifierConfidence: fresh.confidence.score,
      dedupHash: fresh.dedupHash,
      suggestion: fresh.suggestion,
      teenContent,
      childId,
      classifierMetrics: fresh.runMetrics,
    });

    if (duplicate) {
      logger.debug({ familyId, eventId }, 'orchestrator: duplicate event, skipping downstream');
      return;
    }
    classified = {
      eventId,
      eventType: fresh.eventType,
      payload: fresh.payload,
      confidence: fresh.confidence.score,
      suggestion: fresh.suggestion,
      teenContent,
    };
  }

  const eventId = classified.eventId;
  const resumingFromDraft = resume?.status === 'drafted';

  // 3. Route by confidence + suggestion.
  if (classified.confidence < CONFIDENCE_HUMAN_THRESHOLD) {
    logger.info(
      { familyId, eventId, confidence: classified.confidence },
      'orchestrator: low classifier confidence — routed to human queue',
    );
    await recordDrop({
      familyId,
      eventId,
      reason: 'low_confidence',
      detail: { confidence: classified.confidence },
    });
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
    await recordDrop({
      familyId,
      eventId,
      reason: 'needs_human',
      detail: { suggestion: classified.suggestion.kind },
    });
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
    await recordDrop({
      familyId,
      eventId,
      reason: 'unknown_action_type',
      detail: { actionType },
    });
    return;
  }

  // 4. Draft — skipped if a prior pass already drafted (resume from `drafted`).
  // The autonomy threshold gates *execution*, not drafting; drafting runs for
  // everything ≥ HUMAN_THRESHOLD to populate /drafts.
  let draft: DraftedAction;
  let actionId: string;
  if (resumingFromDraft) {
    const existing = await loadActionForEvent(eventId);
    if (!existing) {
      throw new Error(
        `orchestrator: event ${eventId} at 'drafted' but no action row found — cannot resume`,
      );
    }
    actionId = existing.actionId;
    draft = {
      id: existing.actionId,
      eventId,
      familyId,
      actionType: existing.actionType,
      payload: existing.payload,
      draftConfidence: classified.confidence,
      rationale: 'resumed from stored draft',
      recipientVisibility: 'internal_only',
      draftedAt: new Date().toISOString(),
    };
    logger.info({ familyId, eventId, actionId }, 'orchestrator: resuming from stored draft');
  } else {
    // add_to_routine is a deterministic, internal-only routine pin built from the
    // already-known accepted-candidate payload (title/kind/summary) — there is
    // nothing for the drafter to compose, so we skip its LLM call rather than
    // prompt for content we already have. Every other action type drafts via the
    // LLM as before. Both feed the same recordAction (and therefore the same
    // reviewer → autonomy-gate spine).
    let drafterMetrics: AgentRunMetrics;
    if (actionType === 'add_to_routine') {
      draft = {
        id: crypto.randomUUID(),
        eventId,
        familyId,
        actionType,
        payload: classified.payload,
        draftConfidence: classified.confidence,
        rationale: 'accepted village item pinned to routine',
        recipientVisibility: 'internal_only',
        draftedAt: new Date().toISOString(),
      };
      drafterMetrics = {
        agentName: 'drafter',
        modelUsed: 'deterministic',
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        latencyMs: 0,
      };
    } else {
      // The drafter consults the family's longitudinal memory for context
      // (voice, routines, preferences). An empty slice {facts:[],episodes:[]}
      // is passed through as-is so a memory-less family drafts gracefully —
      // never null-masked.
      const slice = await getMemorySlice(familyId);
      const drafted = await runDrafter({
        familyId,
        event: { eventId, eventType: classified.eventType, payload: classified.payload },
        actionType,
        memorySlice: { relevantFacts: slice.facts, relevantEpisodes: slice.episodes },
      });
      draft = drafted.draft;
      drafterMetrics = drafted.runMetrics;
    }

    // recordAction advances the event to 'drafted' inside its own transaction
    // (FIX 2 atomic fold) — no separate markEventStage('drafted') needed.
    const recorded = await recordAction({
      familyId,
      eventId,
      actionType: draft.actionType,
      payload: draft.payload,
      drafterMetrics,
    });
    actionId = recorded.actionId;
  }

  // 5. Review
  const reviewed = await runReviewer({ familyId, draft });
  const verdict = reviewed.verdict;
  await recordReviewerVerdict({ actionId, verdict, reviewerMetrics: reviewed.runMetrics });

  // FIX 1: 'reviewed' is marked ONLY for outcomes that do NOT execute (a
  // rejection, an entitlement gate, or below-autonomy-threshold) — those are
  // terminal on resume. The execute path checkpoints 'approved_pending_execute'
  // instead, so a crash in the execute window is re-driven, not dropped.

  if (verdict.kind !== 'approve') {
    await markEventStage(familyId, eventId, 'reviewed');
    logger.info(
      { familyId, actionId, verdict: verdict.kind, rationale: verdict.rationale },
      'orchestrator: reviewer did not approve — surfaced to user',
    );
    await recordReviewerRejection({
      familyId,
      actionId,
      verdictKind: verdict.kind,
      rationale: verdict.rationale,
    });
    return;
  }

  // B18 entitlement gate — sits structurally in front of autonomous execution.
  // An action whose tier requirements the family's plan does not cover NEVER
  // goes autonomous; it stays at its drafted_for_approval default (drafting and
  // review of paid features is allowed on every tier — only EXECUTION is gated).
  const planTier = await loadFamilyPlanTier(familyId);
  const requiredEntitlement = entitlementRequiredFor(draft.actionType);
  const gated =
    !hasEntitlement(planTier, 'autonomy_l3') ||
    (requiredEntitlement !== null && !hasEntitlement(planTier, requiredEntitlement));
  if (gated) {
    await markEventStage(familyId, eventId, 'reviewed');
    const missing = !hasEntitlement(planTier, 'autonomy_l3')
      ? ('autonomy_l3' as const)
      : (requiredEntitlement as NonNullable<typeof requiredEntitlement>);
    logger.info(
      { familyId, actionId, planTier, actionType: draft.actionType, missing },
      'orchestrator: plan tier lacks required entitlement — drafted for approval (not autonomous)',
    );
    await recordEntitlementGate({
      familyId,
      actionId,
      actionType: draft.actionType,
      planTier,
      requiredEntitlement: missing,
    });
    return;
  }

  // Per-child fairness valve — sits AFTER the entitlement gate, throttling
  // AUTONOMY only. A family that has blown past its month-to-date LLM-cost
  // allowance (scaled by child count so big families aren't unfairly cut off)
  // does NOT auto-execute; the action stays at its drafted_for_approval default
  // and a distinct action.gated.over_allowance audit carries an upgrade nudge.
  // childCount is the raw children-row count (one stage per child); reuses the
  // familyContext loaded once above rather than a second query.
  const childCount = familyContext.stages.length;
  const monthToDateCostUsd = await loadFamilyMonthToDateCostUsd(familyId);
  if (isOverAllowance(monthToDateCostUsd, planTier, childCount)) {
    await markEventStage(familyId, eventId, 'reviewed');
    const allowanceUsd = monthlyAllowanceUsd(planTier, childCount);
    logger.info(
      { familyId, actionId, planTier, childCount, monthToDateCostUsd, allowanceUsd },
      'orchestrator: family over monthly LLM-cost allowance — drafted for approval (autonomy paused)',
    );
    await recordActionGate({
      familyId,
      actionId,
      actionType: draft.actionType,
      reason: 'over_allowance',
      detail: {
        planTier,
        childCount,
        monthToDateCostUsd,
        allowanceUsd,
        nudge:
          planTier === 'free'
            ? 'Upgrade to Plus to raise your monthly automation allowance.'
            : 'You have reached this month’s automation allowance; Hale will keep drafting for your approval and resume acting on its own next month.',
      },
    });
    return;
  }

  if (classified.confidence < CONFIDENCE_AUTONOMY_THRESHOLD) {
    await markEventStage(familyId, eventId, 'reviewed');
    logger.info(
      { familyId, actionId, confidence: classified.confidence },
      'orchestrator: reviewer approved but confidence below autonomy threshold — drafted for approval',
    );
    return;
  }

  // Rule #1 teen-redaction cap — a HARD structural cap that overrides the model:
  // a family with a teenager + a teen-content event never auto-executes,
  // regardless of suggestion. Reuses the `stages` loaded once above (same source
  // the classifier was given), so the model's pack and this cap can't disagree.
  if (teenRedactionCapApplies(stages, classified.teenContent)) {
    await markEventStage(familyId, eventId, 'reviewed');
    logger.info(
      { familyId, actionId, actionType: draft.actionType },
      'orchestrator: teen-content event in a family with a teenager — hard-capped to drafted_for_approval',
    );
    await recordActionGate({
      familyId,
      actionId,
      actionType: draft.actionType,
      reason: 'teen_redaction',
      detail: { stages },
    });
    return;
  }

  // Rule #4 — the 7-day observe window. A family younger than the window NEVER
  // auto-executes; everything is drafted for approval.
  const familyCreatedAt = await loadFamilyCreatedAt(familyId);
  if (withinObservationWindow(familyCreatedAt)) {
    await markEventStage(familyId, eventId, 'reviewed');
    logger.info(
      { familyId, actionId, familyCreatedAt },
      'orchestrator: family inside 7-day observe window — drafted for approval (not autonomous)',
    );
    await recordActionGate({
      familyId,
      actionId,
      actionType: draft.actionType,
      reason: 'observation_window',
      detail: { familyCreatedAt: familyCreatedAt.toISOString() },
    });
    return;
  }

  // Rule #4 — the per-action-type 5-streak. Autonomy of an action type unlocks
  // only after ≥5 consecutive most-recent human-approved completions of it.
  const approvalHistory = await loadActionApprovalHistory(familyId);
  if (!streakSatisfiesAutonomy(draft.actionType, approvalHistory)) {
    await markEventStage(familyId, eventId, 'reviewed');
    logger.info(
      { familyId, actionId, actionType: draft.actionType },
      'orchestrator: action type has not reached the 5-streak unlock — drafted for approval',
    );
    await recordActionGate({
      familyId,
      actionId,
      actionType: draft.actionType,
      reason: 'streak',
      detail: { required: 5 },
    });
    return;
  }

  // Rule #5 — cross-parent consent. For an action type that touches both
  // parents' data, a co-parent's presence requires an active consent record;
  // missing → never autonomous. No co-parent → single-parent household, proceeds.
  if (isCrossParentActionType(draft.actionType)) {
    const consent = await loadCrossParentConsent(familyId);
    if (consent.hasCoParent && !consent.coParentConsentGranted) {
      await markEventStage(familyId, eventId, 'reviewed');
      logger.info(
        { familyId, actionId, actionType: draft.actionType },
        'orchestrator: cross-parent action without co-parent consent — drafted for approval',
      );
      await recordActionGate({
        familyId,
        actionId,
        actionType: draft.actionType,
        reason: 'cross_parent_consent',
        detail: { hasCoParent: true, coParentConsentGranted: false },
      });
      return;
    }
  }

  // Mint BEFORE the checkpoint: minting can throw (coverage/result gate, hard
  // rules #3 + #7), and a throw here must NOT leave a phantom
  // 'approved_pending_execute' that resume would re-drive.
  const approved = mintApprovedAction(draft, verdict, coverageSatisfiedWithResults);

  // FIX 1: the resumable pre-executor checkpoint. A crash after this and before
  // recordExecution leaves the event here; the redelivery re-drives the executor.
  await markEventStage(familyId, eventId, 'approved_pending_execute');
  await executeAndRecord(familyId, eventId, actionId, approved);
}

/**
 * Runs the executor for a minted, autonomy-qualified action and advances the
 * event to its terminal outcome ('actioned' on success, 'failed' otherwise).
 * Shared by the live path and the FIX 1 resume path so both record identically.
 * The outbound_sends claim inside the executor is the true double-send guard;
 * this advances the event status so resume sees a terminal state next time.
 */
async function executeAndRecord(
  familyId: string,
  eventId: string,
  actionId: string,
  approved: ApprovedAction,
): Promise<void> {
  try {
    const execution = await runExecutor({ familyId, approved });
    await recordExecution({ actionId, result: execution.detail, ok: execution.ok });
    await markEventStage(familyId, eventId, execution.ok ? 'actioned' : 'failed');
    logger.info({ familyId, actionId, ok: execution.ok }, 'orchestrator: action executed');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown executor error';
    logger.error({ familyId, actionId, err }, 'orchestrator: executor failed');
    await recordExecution({ actionId, result: { error: message }, ok: false });
    await markEventStage(familyId, eventId, 'failed');
  }
}

/**
 * FIX 1 resume: re-drive a crashed-mid-execute action. Loads the persisted
 * draft + approved verdict, re-mints the ApprovedAction (the stored tool-result
 * `ok` flags re-gate it exactly as the original pass), and runs the executor.
 * The outbound_sends claim guarantees the provider is hit at most once.
 *
 * Before re-driving, the rule-#1 teen-redaction cap is re-applied with the
 * PERSISTED teen_content + the family's current stages — a hard structural cap
 * that overrides a stale checkpoint. A teen-content action in a teenager family
 * that reached this checkpoint (e.g. a checkpoint written before the cap was
 * wired) is held back to drafted_for_approval, NOT executed.
 */
async function resumeIntoExecutor(
  familyId: string,
  eventId: string,
  teenContent: boolean,
): Promise<void> {
  const existing = await loadActionForEvent(eventId);
  if (!existing) {
    throw new Error(
      `orchestrator: event ${eventId} at 'approved_pending_execute' but no action row found`,
    );
  }

  const familyContext = await loadFamilyContext(familyId);
  const stages: FamilyStage[] =
    familyContext.stages.length > 0 ? familyContext.stages : ['newborn'];
  if (teenRedactionCapApplies(stages, teenContent)) {
    await markEventStage(familyId, eventId, 'reviewed');
    logger.info(
      { familyId, eventId, actionId: existing.actionId, actionType: existing.actionType },
      'orchestrator: teen-content event at approved_pending_execute in a family with a teenager — re-capped on resume (executor not reached)',
    );
    await recordActionGate({
      familyId,
      actionId: existing.actionId,
      actionType: existing.actionType,
      reason: 'teen_redaction',
      detail: { stages, resumed: true },
    });
    return;
  }

  const verdict = await loadApprovedVerdictForAction(existing.actionId);
  if (!verdict || verdict.kind !== 'approve') {
    throw new Error(
      `orchestrator: action ${existing.actionId} at 'approved_pending_execute' has no stored approve verdict`,
    );
  }
  const draft: DraftedAction = {
    id: existing.actionId,
    eventId,
    familyId,
    actionType: existing.actionType,
    payload: existing.payload,
    draftConfidence: CONFIDENCE_AUTONOMY_THRESHOLD,
    rationale: 'resumed from approved_pending_execute checkpoint',
    recipientVisibility: 'internal_only',
    draftedAt: new Date().toISOString(),
  };
  logger.info(
    { familyId, eventId, actionId: existing.actionId },
    'orchestrator: resuming approved_pending_execute into executor',
  );
  const approved = mintApprovedAction(draft, verdict, coverageSatisfiedWithResults);
  await executeAndRecord(familyId, eventId, existing.actionId, approved);
}

/**
 * Injectable seams for the human-approve execution path, so the control flow is
 * unit-testable without a live DB/executor/queue. Defaults bind to the real
 * memory-writer + the orchestrator's own mint+execute machinery.
 */
export interface ExecuteApprovedDeps {
  loadAction: typeof loadActionForApproval;
  loadConsent: typeof loadCrossParentConsent;
  recordApproval: typeof recordHumanApproval;
  recordGate: typeof recordActionGate;
  execute: typeof executeAndRecord;
  log: Pick<typeof logger, 'info' | 'warn'>;
}

function defaultExecuteApprovedDeps(): ExecuteApprovedDeps {
  return {
    loadAction: loadActionForApproval,
    loadConsent: loadCrossParentConsent,
    recordApproval: recordHumanApproval,
    recordGate: recordActionGate,
    execute: executeAndRecord,
    log: logger,
  };
}

/**
 * Drives a HUMAN-approved drafted action into execution (definition-of-done
 * box 3, worker half — the consumer of the actions.approved contract).
 *
 * Preconditions, both required (a non-approved or already-executed action must
 * never execute here): the action is still 'drafted_for_approval' AND it carries
 * a stored reviewer 'approve' verdict whose tool results re-gate the mint exactly
 * as the autonomous path does (hard rules #3 + #7, via coverageSatisfiedWithResults
 * inside mintApprovedAction). A failed precondition logs and drops — never throws,
 * never executes (a queue throw would only spin pg-boss's retry on a payload that
 * can't become valid).
 *
 * CONSENT BOUNDARY (hard rule #5): a human's approval IS the override for the
 * AUTONOMY gates (streak / 7-day window / confidence / entitlement-for-autonomy) —
 * that is the entire point of L2 "draft → human approves → execute". Those gates
 * decide whether HALE may act on its own; once a parent says "yes, send it", they
 * no longer apply. Cross-parent consent is NOT an autonomy gate — it is a separate
 * legal requirement that BOTH parents authorize Hale to act on their jointly-held
 * child's data. One parent's approval cannot waive the other parent's consent, so
 * this gate is re-checked here and a missing co-parent consent REFUSES execution
 * (audited action.gated.cross_parent_consent), even with a valid human approval.
 */
export async function executeApprovedAction(
  input: { actionId: string; familyId: string; approvedBy: string },
  deps: ExecuteApprovedDeps = defaultExecuteApprovedDeps(),
): Promise<void> {
  const { actionId, familyId, approvedBy } = input;

  const action = await deps.loadAction(actionId);
  if (!action) {
    deps.log.warn({ familyId, actionId }, 'actions.approved: action not found — dropping');
    return;
  }
  if (action.userVisibleState !== 'drafted_for_approval') {
    deps.log.warn(
      { familyId, actionId, userVisibleState: action.userVisibleState },
      'actions.approved: action not in drafted_for_approval (already executed or held) — dropping',
    );
    return;
  }
  if (!action.verdict) {
    deps.log.warn(
      { familyId, actionId },
      'actions.approved: action has no stored approve verdict — dropping',
    );
    return;
  }

  // Hard rule #5 — the one gate a human approval CANNOT override (see the
  // CONSENT BOUNDARY note above). Re-checked at approval time, not just at draft
  // time, because the co-parent may have signed up between draft and approval.
  if (isCrossParentActionType(action.actionType)) {
    const consent = await deps.loadConsent(familyId);
    if (consent.hasCoParent && !consent.coParentConsentGranted) {
      deps.log.warn(
        { familyId, actionId, actionType: action.actionType },
        'actions.approved: cross-parent action without co-parent consent — refused (human approval cannot waive two-parent consent)',
      );
      await deps.recordGate({
        familyId,
        actionId,
        actionType: action.actionType,
        reason: 'cross_parent_consent',
        detail: { hasCoParent: true, coParentConsentGranted: false, approvedBy },
      });
      return;
    }
  }

  const draft: DraftedAction = {
    id: actionId,
    eventId: action.eventId,
    familyId,
    actionType: action.actionType,
    payload: action.payload,
    draftConfidence: CONFIDENCE_HUMAN_THRESHOLD,
    rationale: 'human-approved drafted action',
    recipientVisibility: 'internal_only',
    draftedAt: new Date().toISOString(),
  };

  // Re-mint BEFORE recording the approval/checkpoint: a coverage/result failure
  // must throw before any 'approved_pending_execute' state is written.
  const approved = mintApprovedAction(draft, action.verdict, coverageSatisfiedWithResults);

  // Record WHO approved (PIPEDA right-to-access) and advance to the resumable
  // pre-executor checkpoint atomically, then execute.
  await deps.recordApproval({ familyId, eventId: action.eventId, actionId, approvedBy });
  deps.log.info(
    { familyId, actionId, approvedBy, actionType: action.actionType },
    'actions.approved: human-approved action driving into execution',
  );
  await deps.execute(familyId, action.eventId, actionId, approved);
}
