import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestedEventPayload } from '@hale/tools-contracts';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import type { ClassifierSuggestion } from '@hale/types';

/**
 * No plan gate (VIL-131). Invariant: a family's plan never decides whether an
 * approved, high-confidence, opted-in, streak-satisfied action executes. The
 * memory-writer mock is in its post-change shape (no plan-tier or month-to-date
 * cost reader, no entitlement-gate writer), so a plan read would throw here.
 *
 * The one brake that stays is AUTONOMOUS_EXECUTE_ENABLED: anything but 'true' and
 * the action is held with the named outcome 'lane_off'; 'true' and the executor
 * runs. The observation-window case is the positive control that the gates bite.
 *
 * Classifier/drafter/reviewer are stubbed (the existing orchestrator-test pattern)
 * to test deterministic routing downstream of a stipulated verdict; no prompt is
 * under test.
 */

const LANE = 'AUTONOMOUS_EXECUTE_ENABLED';

const metrics: AgentRunMetrics = {
  agentName: 'classifier',
  modelUsed: 'claude-haiku-4-5',
  promptTokens: 10,
  completionTokens: 5,
  costUsd: 0.0001,
  latencyMs: 1,
};

const suggestion: ClassifierSuggestion = { kind: 'autonomous_action', actionType: 'calendar_add' };

const runClassifier = vi.fn(async () => ({
  eventType: 'school_notice',
  payload: { subject: 'Open house' },
  confidence: { score: 0.95, rationale: 'a dated event to place' },
  suggestion,
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
    actionType: 'calendar_add' as const,
    payload: {},
    draftConfidence: 0.95,
    rationale: 'place the open house',
    recipientVisibility: 'internal_only' as const,
    draftedAt: '2026-06-12T10:00:00.000Z',
  },
  runMetrics: { ...metrics, agentName: 'drafter' as const },
}));

const CALENDAR_ADD_COVERAGE = [
  { tool: 'check_action_time_window', ok: true, result: {} },
  { tool: 'check_action_idempotency', ok: true, result: {} },
  { tool: 'check_calendar_conflict', ok: true, result: {} },
];

const runReviewer = vi.fn(async () => ({
  verdict: {
    kind: 'approve' as const,
    toolResults: CALENDAR_ADD_COVERAGE,
    rationale: 'in window, not a duplicate, no conflict',
  },
  runMetrics: { ...metrics, agentName: 'reviewer' as const },
}));

const runExecutor = vi.fn(async () => ({ ok: true, detail: {} }));
vi.mock('../agents/drafter.js', () => ({ runDrafter: () => runDrafter() }));
vi.mock('../agents/reviewer.js', () => ({ runReviewer: () => runReviewer() }));
vi.mock('../services/executor.js', () => ({ runExecutor: () => runExecutor() }));

const OLD_FAMILY = new Date('2020-01-01T00:00:00.000Z');
let familyCreatedAt = OLD_FAMILY;
let resumePoint: Record<string, unknown> | null = null;
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
  loadActionForEvent: vi.fn(async () => ({
    actionId: 'action-1',
    actionType: 'calendar_add',
    payload: {},
  })),
  loadApprovedVerdictForAction: vi.fn(async () => ({
    kind: 'approve' as const,
    toolResults: CALENDAR_ADD_COVERAGE,
    rationale: 'stored',
  })),
  loadFamilyCreatedAt: vi.fn(async () => familyCreatedAt),
  loadActionApprovalHistory: vi.fn(async () =>
    Array.from({ length: 5 }, () => ({ actionType: 'calendar_add', humanApproved: true })),
  ),
  loadCrossParentConsent: vi.fn(async () => ({
    hasCoParent: false,
    coParentConsentGranted: false,
  })),
  hasAutonomousActionOptIn: vi.fn(async () => true),
  getMemorySlice: vi.fn(async () => ({ facts: [], episodes: [] })),
  loadFamilyContext: vi.fn(async () => ({
    stages: ['toddler'],
    children: [],
    contextSlice: { childrenAgesMonths: [24] },
  })),
}));

const { runOrchestrator } = await import('./index.js');

const job: IngestedEventPayload = {
  family_id: 'fam-1',
  source: 'gmail',
  payload: { messageId: 'm1' },
  received_at: '2026-06-12T10:00:00.000Z',
};

describe('runOrchestrator — no plan gate; the execute lane is the only added brake', () => {
  beforeEach(() => {
    recordActionGate.mockClear();
    recordExecution.mockClear();
    markEventStage.mockClear();
    runExecutor.mockClear();
    familyCreatedAt = OLD_FAMILY;
    resumePoint = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lane on + eligible calendar_add (0.95, 5-streak, opted in) → executes once, no gate', async () => {
    vi.stubEnv(LANE, 'true');
    await runOrchestrator(job);

    expect(recordActionGate).not.toHaveBeenCalled();
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordExecution).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'action-1', ok: true }),
    );
    expect(markEventStage).toHaveBeenCalledWith('fam-1', 'evt-1', 'approved_pending_execute');
  });

  it('positive control: family created now → observation_window gate, executor not called', async () => {
    vi.stubEnv(LANE, 'true');
    familyCreatedAt = new Date();
    await runOrchestrator(job);

    expect(recordActionGate).toHaveBeenCalledTimes(1);
    expect(recordActionGate).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'fam-1',
        actionId: 'action-1',
        actionType: 'calendar_add',
        reason: 'observation_window',
      }),
    );
    expect(runExecutor).not.toHaveBeenCalled();
  });

  it('lane unset → held as lane_off (no execute checkpoint), executor not called', async () => {
    vi.stubEnv(LANE, '');
    await runOrchestrator(job);

    expect(recordActionGate).toHaveBeenCalledTimes(1);
    expect(recordActionGate).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'fam-1',
        actionId: 'action-1',
        actionType: 'calendar_add',
        reason: 'lane_off',
      }),
    );
    expect(markEventStage).toHaveBeenCalledWith('fam-1', 'evt-1', 'reviewed');
    expect(markEventStage).not.toHaveBeenCalledWith('fam-1', 'evt-1', 'approved_pending_execute');
    expect(runExecutor).not.toHaveBeenCalled();
    expect(recordExecution).not.toHaveBeenCalled();
  });

  it('lane set to anything but the exact string true → held as lane_off', async () => {
    vi.stubEnv(LANE, 'yes');
    await runOrchestrator(job);

    expect(recordActionGate).toHaveBeenCalledWith(expect.objectContaining({ reason: 'lane_off' }));
    expect(runExecutor).not.toHaveBeenCalled();
  });

  it('lane unset + an approved_pending_execute checkpoint on resume → lane_off, executor not called', async () => {
    vi.stubEnv(LANE, '');
    resumePoint = { eventId: 'evt-1', status: 'approved_pending_execute', teenContent: false };
    await runOrchestrator(job);

    expect(recordActionGate).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'fam-1',
        actionId: 'action-1',
        actionType: 'calendar_add',
        reason: 'lane_off',
      }),
    );
    expect(markEventStage).toHaveBeenCalledWith('fam-1', 'evt-1', 'reviewed');
    expect(runExecutor).not.toHaveBeenCalled();
  });
});
