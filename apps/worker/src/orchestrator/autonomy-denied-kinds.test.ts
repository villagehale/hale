import { REQUIRED_CHECKS } from '@hale/tools-contracts';
import type { ActionType } from '@hale/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestedEventPayload } from '@hale/tools-contracts';
import type { AgentRunMetrics } from '../agents/run-metrics.js';

/**
 * Booking, registration and paying are never autonomous (Barton, 2026-10-11): an
 * explicit deny in code, not a side effect of the executor being unwired. Every case
 * runs the fully eligible fixture — opted in, a 5-streak of the kind, confidence 0.95,
 * an old family, the lane exactly 'true', and a verdict carrying every required check —
 * so the only thing that can hold a denied kind is the deny itself. The executor is a
 * stub that would succeed, which is the world where the kind's executor is wired.
 *
 * Classifier/drafter/reviewer are stubbed (the existing orchestrator-test pattern) to
 * test deterministic routing downstream of a stipulated verdict; no prompt is under test.
 */

const DENIED_KINDS: ActionType[] = [
  'place_supply_order',
  'cancel_supply_order',
  'fill_pdf_form',
  'submit_government_form',
  'book_clinic_portal',
  'cancel_clinic_appointment',
];

const metrics: AgentRunMetrics = {
  agentName: 'classifier',
  modelUsed: 'claude-haiku-4-5',
  promptTokens: 10,
  completionTokens: 5,
  costUsd: 0.0001,
  latencyMs: 1,
};

let kind: ActionType = 'calendar_add';
let resumePoint: Record<string, unknown> | null = null;
let humanApprover: string | null = null;

function fullCoverage(actionType: ActionType) {
  return REQUIRED_CHECKS[actionType].map((tool) => ({ tool, ok: true, result: {} }));
}

const runClassifier = vi.fn(async () => ({
  eventType: 'school_notice',
  payload: { subject: 'notice' },
  confidence: { score: 0.95, rationale: 'clear' },
  suggestion: { kind: 'autonomous_action' as const, actionType: kind },
  teenContent: false,
  dedupHash: 'fixed-hash',
  runMetrics: metrics,
}));
vi.mock('../agents/classifier.js', () => ({ runClassifier: () => runClassifier() }));
vi.mock('../agents/dedup.js', () => ({ dedupHashFor: () => 'fixed-hash' }));

const runDrafter = vi.fn(async () => ({
  draft: {
    id: 'action-1',
    eventId: 'evt-1',
    familyId: 'fam-1',
    actionType: kind,
    payload: {},
    draftConfidence: 0.95,
    rationale: 'drafted',
    recipientVisibility: 'internal_only' as const,
    draftedAt: '2026-06-12T10:00:00.000Z',
  },
  runMetrics: { ...metrics, agentName: 'drafter' as const },
}));

const runReviewer = vi.fn(async () => ({
  verdict: { kind: 'approve' as const, toolResults: fullCoverage(kind), rationale: 'all green' },
  runMetrics: { ...metrics, agentName: 'reviewer' as const },
}));

const runExecutor = vi.fn(async () => ({ ok: true, detail: {} }));
vi.mock('../agents/drafter.js', () => ({ runDrafter: () => runDrafter() }));
vi.mock('../agents/reviewer.js', () => ({ runReviewer: () => runReviewer() }));
vi.mock('../services/executor.js', () => ({ runExecutor: () => runExecutor() }));

const recordActionGate = vi.fn(async () => {});
const recordExecution = vi.fn(async () => {});
const markEventStage = vi.fn(async () => {});

vi.mock('../services/memory-writer.js', () => ({
  loadResumePoint: vi.fn(async () => resumePoint),
  recordEvent: vi.fn(async () => ({ eventId: 'evt-1', duplicate: false })),
  recordAction: vi.fn(async () => ({ actionId: 'action-1', drafterRunId: 'run-1' })),
  recordReviewerVerdict: vi.fn(async () => {}),
  recordReviewerRejection: vi.fn(async () => {}),
  recordActionGate: (...args: unknown[]) => recordActionGate(...(args as [])),
  recordExecution: (...args: unknown[]) => recordExecution(...(args as [])),
  recordDrop: vi.fn(async () => {}),
  markEventStage: (...args: unknown[]) => markEventStage(...(args as [])),
  loadActionForEvent: vi.fn(async () => ({ actionId: 'action-1', actionType: kind, payload: {} })),
  loadApprovedVerdictForAction: vi.fn(async () => ({
    kind: 'approve' as const,
    toolResults: fullCoverage(kind),
    rationale: 'stored',
  })),
  loadHumanApprover: vi.fn(async () => humanApprover),
  loadFamilyCreatedAt: vi.fn(async () => new Date('2020-01-01T00:00:00.000Z')),
  loadActionForApproval: vi.fn(async () => null),
  recordHumanApproval: vi.fn(async () => ({ claimed: true as const, autonomy: { outcome: 'not_reached' as const } })),
  autonomyTurnOnDelivered: vi.fn(async () => true),
  loadAutonomyStanding: vi.fn(async () => [
    { parentUserId: 'parent-1', streakReached: true, optedIn: true },
  ]),
  loadCrossParentConsent: vi.fn(async () => ({
    hasCoParent: false,
    coParentConsentGranted: false,
  })),
  getMemorySlice: vi.fn(async () => ({ facts: [], episodes: [] })),
  loadFamilyContext: vi.fn(async () => ({
    stages: ['toddler'],
    children: [],
    contextSlice: { childrenAgesMonths: [24] },
  })),
}));

const { defaultExecuteApprovedDeps, executeApprovedAction, runOrchestrator } = await import(
  './index.js'
);

const job: IngestedEventPayload = {
  family_id: 'fam-1',
  source: 'gmail',
  payload: { messageId: 'm1' },
  received_at: '2026-06-12T10:00:00.000Z',
};

describe('runOrchestrator — booking, registration and paying are never autonomous', () => {
  beforeEach(() => {
    vi.stubEnv('AUTONOMOUS_EXECUTE_ENABLED', 'true');
    recordActionGate.mockClear();
    recordExecution.mockClear();
    markEventStage.mockClear();
    runExecutor.mockClear();
    resumePoint = null;
    humanApprover = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(DENIED_KINDS)('%s, fully eligible → gated autonomy_denied_kind, executor not called', async (denied) => {
    kind = denied;
    await runOrchestrator(job);

    expect(recordActionGate).toHaveBeenCalledTimes(1);
    expect(recordActionGate).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'fam-1',
        actionId: 'action-1',
        actionType: denied,
        reason: 'autonomy_denied_kind',
      }),
    );
    expect(markEventStage).toHaveBeenCalledWith('fam-1', 'evt-1', 'reviewed');
    expect(markEventStage).not.toHaveBeenCalledWith('fam-1', 'evt-1', 'approved_pending_execute');
    expect(runExecutor).not.toHaveBeenCalled();
  });

  it.each(['calendar_add', 'send_email'] as const)(
    'positive control: %s with the same fixture → executes, no gate',
    async (allowed) => {
      kind = allowed;
      await runOrchestrator(job);

      expect(recordActionGate).not.toHaveBeenCalled();
      expect(runExecutor).toHaveBeenCalledTimes(1);
    },
  );

  it.each(DENIED_KINDS)(
    '%s at an approved_pending_execute checkpoint with no human approval → re-gated on resume',
    async (denied) => {
      kind = denied;
      resumePoint = { eventId: 'evt-1', status: 'approved_pending_execute', teenContent: false };
      await runOrchestrator(job);

      expect(recordActionGate).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'action-1',
          actionType: denied,
          reason: 'autonomy_denied_kind',
          detail: { resumed: true },
        }),
      );
      expect(markEventStage).toHaveBeenCalledWith('fam-1', 'evt-1', 'reviewed');
      expect(runExecutor).not.toHaveBeenCalled();
    },
  );

  it("a denied kind's checkpoint claimed by a human approval → resumes into the executor", async () => {
    kind = 'book_clinic_portal';
    humanApprover = 'parent-1';
    resumePoint = { eventId: 'evt-1', status: 'approved_pending_execute', teenContent: false };
    await runOrchestrator(job);

    expect(recordActionGate).not.toHaveBeenCalled();
    expect(markEventStage).not.toHaveBeenCalledWith('fam-1', 'evt-1', 'reviewed');
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordExecution).toHaveBeenCalledWith({
      actionId: 'action-1',
      result: {},
      ok: true,
      decision: { source: 'human', reason: 'stored' },
    });
  });

  it('an autonomous send_email records its decision and the reviewer reason on the execution', async () => {
    kind = 'send_email';
    await runOrchestrator(job);

    expect(recordExecution).toHaveBeenCalledWith({
      actionId: 'action-1',
      result: {},
      ok: true,
      decision: { source: 'autonomous', reason: 'all green' },
    });
  });

  it('a held denied kind is still executed by a human approval', async () => {
    kind = 'fill_pdf_form';
    await runOrchestrator(job);
    expect(runExecutor).not.toHaveBeenCalled();

    await executeApprovedAction(
      {
        actionId: 'action-1',
        familyId: 'fam-1',
        approvedBy: 'parent-1',
        policyVersion: 'test-policy',
      },
      {
        ...defaultExecuteApprovedDeps(),
        loadAction: async () => ({
          eventId: 'evt-1',
          actionType: 'fill_pdf_form',
          payload: {},
          userVisibleState: 'drafted_for_approval',
          verdict: { kind: 'approve', toolResults: fullCoverage('fill_pdf_form'), rationale: 'ok' },
        }),
        loadConsent: async () => ({ hasCoParent: false, coParentConsentGranted: false }),
        recordApproval: vi.fn(async () => ({ claimed: true as const, autonomy: { outcome: 'not_reached' as const } })),
        recordGate: vi.fn(async () => {}),
      },
    );

    expect(runExecutor).toHaveBeenCalledTimes(1);
  });
});
