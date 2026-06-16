import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestedEventPayload } from '@hale/tools-contracts';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import type { ClassifierSuggestion, FamilyStage } from '@hale/types';

/**
 * Fix-wave B structural gates wired into the orchestrator AFTER the entitlement
 * gate: rule #4 (7-day observe window + per-action-type 5-streak), rule #5
 * (cross-parent consent), and the teen-redaction cap. Each gated outcome stays
 * drafted_for_approval, never executes, and writes a distinct action.gated.*
 * audit. We inject the family/consent/history/stage lookups and a high-confidence
 * approved action so the ONLY remaining brake is the gate under test.
 */

const metrics: AgentRunMetrics = {
  agentName: 'classifier',
  modelUsed: 'claude-haiku-4-5',
  promptTokens: 10,
  completionTokens: 5,
  costUsd: 0.0001,
  latencyMs: 1,
};

let suggestion: ClassifierSuggestion = { kind: 'autonomous_action', actionType: 'send_email' };
let teenContent = false;

const runClassifier = vi.fn(async () => ({
  eventType: 'pediatric_appointment_request',
  payload: { foo: 'bar' },
  confidence: { score: 0.97, rationale: 'clear' },
  suggestion,
  teenContent,
  dedupHash: 'fixed-hash',
  runMetrics: metrics,
}));
vi.mock('../agents/classifier.js', () => ({ runClassifier: () => runClassifier() }));
vi.mock('../agents/dedup.js', () => ({ dedupHashFor: () => 'fixed-hash' }));

let draftActionType = 'send_email';
const runDrafter = vi.fn(async () => ({
  draft: {
    id: 'action-1',
    eventId: 'evt-1',
    familyId: 'fam-1',
    actionType: draftActionType,
    payload: {},
    draftConfidence: 0.97,
    rationale: 'draft',
    recipientVisibility: 'public' as const,
    draftedAt: '2026-06-12T10:00:00.000Z',
  },
  runMetrics: { ...metrics, agentName: 'drafter' as const },
}));

// Reviewer approves with full coverage for the action under test so the verdict
// is never the reason a gate fires.
const COVERAGE: Record<string, { tool: string; ok: boolean; result: unknown }[]> = {
  send_email: [
    { tool: 'check_pii_leak', ok: true, result: {} },
    { tool: 'check_recipient_allowlist', ok: true, result: {} },
    { tool: 'check_action_idempotency', ok: true, result: {} },
  ],
  share_photos_with_family: [
    { tool: 'check_pii_leak', ok: true, result: {} },
    { tool: 'check_recipient_allowlist', ok: true, result: {} },
    { tool: 'check_action_idempotency', ok: true, result: {} },
  ],
};
const runReviewer = vi.fn(async () => ({
  verdict: { kind: 'approve' as const, toolResults: COVERAGE[draftActionType], rationale: 'green' },
  runMetrics: { ...metrics, agentName: 'reviewer' as const },
}));

const runExecutor = vi.fn(async () => ({ ok: true, detail: {} }));
vi.mock('../agents/drafter.js', () => ({ runDrafter: () => runDrafter() }));
vi.mock('../agents/reviewer.js', () => ({ runReviewer: () => runReviewer() }));
vi.mock('../services/executor.js', () => ({ runExecutor: () => runExecutor() }));

// Injectable lookups, defaulted so a family CLEARS every gate unless a test
// tightens one: old family, full streak, single-parent, newborn stage.
let familyCreatedAt = new Date('2020-01-01T00:00:00.000Z');
let approvalHistory: { actionType: string; humanApproved: boolean }[] = Array.from(
  { length: 5 },
  () => ({ actionType: 'send_email', humanApproved: true }),
);
let crossParent = { hasCoParent: false, coParentConsentGranted: false };
let childStages: FamilyStage[] = ['newborn'];

const recordActionGate = vi.fn(async () => {});
const recordExecution = vi.fn(async () => {});

vi.mock('../services/memory-writer.js', () => ({
  loadResumePoint: vi.fn(async () => null),
  recordEvent: vi.fn(async () => ({ eventId: 'evt-1', duplicate: false })),
  recordAction: vi.fn(async () => ({ actionId: 'action-1', drafterRunId: 'run-1' })),
  recordReviewerVerdict: vi.fn(async () => {}),
  recordReviewerRejection: vi.fn(async () => {}),
  recordEntitlementGate: vi.fn(async () => {}),
  recordActionGate: (...args: unknown[]) => recordActionGate(...(args as [])),
  recordExecution: (...args: unknown[]) => recordExecution(...(args as [])),
  recordDrop: vi.fn(async () => {}),
  markEventStage: vi.fn(async () => {}),
  loadActionForEvent: vi.fn(async () => null),
  loadFamilyPlanTier: vi.fn(async () => 'family' as const),
  loadFamilyMonthToDateCostUsd: vi.fn(async () => 0),
  loadFamilyCreatedAt: vi.fn(async () => familyCreatedAt),
  loadActionApprovalHistory: vi.fn(async () => approvalHistory),
  loadCrossParentConsent: vi.fn(async () => crossParent),
  loadFamilyContext: vi.fn(async () => ({
    stages: childStages,
    children: [],
    contextSlice: { childrenAgesMonths: [], province: 'ON', timezone: 'America/Toronto' },
  })),
}));

const { runOrchestrator } = await import('./index.js');

const job: IngestedEventPayload = {
  family_id: 'fam-1',
  source: 'gmail',
  payload: { messageId: 'm1' },
  received_at: '2026-06-12T10:00:00.000Z',
};

describe('runOrchestrator — fix-wave B structural gates', () => {
  beforeEach(() => {
    recordActionGate.mockClear();
    recordExecution.mockClear();
    runExecutor.mockClear();
    // Reset to the all-clear baseline before each test tightens one gate.
    suggestion = { kind: 'autonomous_action', actionType: 'send_email' };
    teenContent = false;
    draftActionType = 'send_email';
    familyCreatedAt = new Date('2020-01-01T00:00:00.000Z');
    approvalHistory = Array.from({ length: 5 }, () => ({
      actionType: 'send_email',
      humanApproved: true,
    }));
    crossParent = { hasCoParent: false, coParentConsentGranted: false };
    childStages = ['newborn'];
  });

  it('baseline (old family, full streak, single-parent, newborn) → executes autonomously', async () => {
    await runOrchestrator(job);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordActionGate).not.toHaveBeenCalled();
  });

  it('rule #4 observe window: family 3 days old → gated, never executes', async () => {
    familyCreatedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await runOrchestrator(job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(recordActionGate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'observation_window', actionType: 'send_email' }),
    );
  });

  it('rule #4 streak: only 4 consecutive human approvals → gated, never executes', async () => {
    approvalHistory = Array.from({ length: 4 }, () => ({
      actionType: 'send_email',
      humanApproved: true,
    }));
    await runOrchestrator(job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(recordActionGate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'streak', actionType: 'send_email' }),
    );
  });

  it('rule #5 cross-parent: co-parent exists but no consent → gated, never executes', async () => {
    suggestion = { kind: 'autonomous_action', actionType: 'share_photos_with_family' };
    draftActionType = 'share_photos_with_family';
    approvalHistory = Array.from({ length: 5 }, () => ({
      actionType: 'share_photos_with_family',
      humanApproved: true,
    }));
    crossParent = { hasCoParent: true, coParentConsentGranted: false };
    await runOrchestrator(job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(recordActionGate).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'cross_parent_consent',
        actionType: 'share_photos_with_family',
      }),
    );
  });

  it('rule #5 cross-parent: co-parent exists WITH consent → proceeds and executes', async () => {
    suggestion = { kind: 'autonomous_action', actionType: 'share_photos_with_family' };
    draftActionType = 'share_photos_with_family';
    approvalHistory = Array.from({ length: 5 }, () => ({
      actionType: 'share_photos_with_family',
      humanApproved: true,
    }));
    crossParent = { hasCoParent: true, coParentConsentGranted: true };
    await runOrchestrator(job);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordActionGate).not.toHaveBeenCalled();
  });

  it('rule #5 cross-parent: NO co-parent (single-parent household) → proceeds and executes', async () => {
    suggestion = { kind: 'autonomous_action', actionType: 'share_photos_with_family' };
    draftActionType = 'share_photos_with_family';
    approvalHistory = Array.from({ length: 5 }, () => ({
      actionType: 'share_photos_with_family',
      humanApproved: true,
    }));
    crossParent = { hasCoParent: false, coParentConsentGranted: false };
    await runOrchestrator(job);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordActionGate).not.toHaveBeenCalled();
  });

  it('teen cap: teenager stage + teen-content + autonomous-eligible → capped, never executes', async () => {
    teenContent = true;
    childStages = ['newborn', 'teenager'];
    await runOrchestrator(job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(recordActionGate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'teen_redaction', actionType: 'send_email' }),
    );
  });
});
