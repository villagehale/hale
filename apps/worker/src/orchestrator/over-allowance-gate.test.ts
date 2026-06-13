import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestedEventPayload } from '@hearth/tools-contracts';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import type { ClassifierSuggestion, FamilyStage } from '@hearth/types';

/**
 * Per-child fairness valve wired into the orchestrator AFTER the entitlement
 * gate: a family over its month-to-date LLM-cost allowance (scaled by child
 * count) does NOT auto-execute — the action stays drafted_for_approval and a
 * distinct action.gated.over_allowance audit is written with an upgrade nudge.
 * It must throttle AUTONOMY only, never block drafting/review (both already ran).
 *
 * We inject the month-to-date cost + child count and an otherwise all-clear
 * approved, high-confidence, autonomy-eligible action so the ONLY remaining brake
 * is the allowance valve under test.
 */

const metrics: AgentRunMetrics = {
  agentName: 'classifier',
  modelUsed: 'claude-haiku-4-5',
  promptTokens: 10,
  completionTokens: 5,
  costUsd: 0.0001,
  latencyMs: 1,
};

const suggestion: ClassifierSuggestion = { kind: 'autonomous_action', actionType: 'send_email' };

const runClassifier = vi.fn(async () => ({
  eventType: 'pediatric_appointment_request',
  payload: { foo: 'bar' },
  confidence: { score: 0.97, rationale: 'clear' },
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
    actionType: 'send_email',
    payload: {},
    draftConfidence: 0.97,
    rationale: 'draft',
    recipientVisibility: 'public' as const,
    draftedAt: '2026-06-12T10:00:00.000Z',
  },
  runMetrics: { ...metrics, agentName: 'drafter' as const },
}));

const runReviewer = vi.fn(async () => ({
  verdict: {
    kind: 'approve' as const,
    toolResults: [
      { tool: 'check_pii_leak', ok: true, result: {} },
      { tool: 'check_recipient_allowlist', ok: true, result: {} },
      { tool: 'check_action_idempotency', ok: true, result: {} },
    ],
    rationale: 'green',
  },
  runMetrics: { ...metrics, agentName: 'reviewer' as const },
}));

const runExecutor = vi.fn(async () => ({ ok: true, detail: {} }));
vi.mock('../agents/drafter.js', () => ({ runDrafter: () => runDrafter() }));
vi.mock('../agents/reviewer.js', () => ({ runReviewer: () => runReviewer() }));
vi.mock('../services/executor.js', () => ({ runExecutor: () => runExecutor() }));

// Injected valve inputs. Baseline: old family, full streak, single-parent,
// newborn — so the allowance valve is the only brake. childStages.length is the
// child count the orchestrator meters against.
let monthToDateCostUsd = 0;
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
  loadFamilyPlanTier: vi.fn(async () => 'plus' as const),
  loadFamilyMonthToDateCostUsd: vi.fn(async () => monthToDateCostUsd),
  loadFamilyCreatedAt: vi.fn(async () => new Date('2020-01-01T00:00:00.000Z')),
  loadActionApprovalHistory: vi.fn(async () =>
    Array.from({ length: 5 }, () => ({ actionType: 'send_email', humanApproved: true })),
  ),
  loadCrossParentConsent: vi.fn(async () => ({ hasCoParent: false, coParentConsentGranted: false })),
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

describe('runOrchestrator — per-child fairness allowance valve', () => {
  beforeEach(() => {
    recordActionGate.mockClear();
    recordExecution.mockClear();
    runExecutor.mockClear();
    monthToDateCostUsd = 0;
    childStages = ['newborn'];
  });

  it('under allowance ($1 spent, plus, 1 child / $5 allowance) → executes autonomously', async () => {
    monthToDateCostUsd = 1.0;
    childStages = ['newborn'];
    await runOrchestrator(job);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordActionGate).not.toHaveBeenCalled();
  });

  it('over allowance ($8 spent, plus, 1 child / $5 allowance) → held, executor not reached, gated audit written', async () => {
    monthToDateCostUsd = 8.0;
    childStages = ['newborn'];
    await runOrchestrator(job);
    expect(runExecutor).not.toHaveBeenCalled();
    expect(recordActionGate).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'over_allowance',
        actionType: 'send_email',
        detail: expect.objectContaining({ allowanceUsd: 5.0, monthToDateCostUsd: 8.0 }),
      }),
    );
  });

  it('fairness: same $8 spend with 3 children ($11 allowance) → within, executes autonomously', async () => {
    monthToDateCostUsd = 8.0;
    childStages = ['newborn', 'newborn', 'teenager'];
    await runOrchestrator(job);
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordActionGate).not.toHaveBeenCalled();
  });
});
