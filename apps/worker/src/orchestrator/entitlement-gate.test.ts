import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestedEventPayload } from '@haru/tools-contracts';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import type { ClassifierSuggestion, PlanTier } from '@haru/types';

/**
 * B18 — the entitlement gate. Invariant: an approved, high-confidence action
 * whose tier requirements the family's plan does NOT cover never goes
 * autonomous — it is recorded as entitlement-gated (stays drafted_for_approval)
 * and the executor is never invoked. We inject the family tier and a commerce
 * action ('place_supply_order' → requires 'commerce', which free lacks) and
 * assert the routing decision via the recorded gate, with no execution.
 */

const metrics: AgentRunMetrics = {
  agentName: 'classifier',
  modelUsed: 'claude-haiku-4-5',
  promptTokens: 10,
  completionTokens: 5,
  costUsd: 0.0001,
  latencyMs: 1,
};

// A commerce action, high confidence (≥ autonomy threshold) so confidence is
// NOT the reason it fails to go autonomous — the entitlement gate must be.
const suggestion: ClassifierSuggestion = {
  kind: 'autonomous_action',
  actionType: 'place_supply_order',
};

const runClassifier = vi.fn(async () => ({
  eventType: 'supply_low_alert',
  payload: { item: 'diapers' },
  confidence: { score: 0.97, rationale: 'clearly a reorder' },
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
    actionType: 'place_supply_order' as const,
    payload: {},
    draftConfidence: 0.97,
    rationale: 'reorder diapers',
    recipientVisibility: 'internal_only' as const,
    draftedAt: '2026-06-12T10:00:00.000Z',
  },
  runMetrics: { ...metrics, agentName: 'drafter' as const },
}));

// Reviewer APPROVES with coverage for place_supply_order (so the verdict check
// passes and the only remaining brake is the entitlement gate).
const runReviewer = vi.fn(async () => ({
  verdict: {
    kind: 'approve' as const,
    toolResults: [
      { tool: 'check_spending_cap', ok: true, result: {} },
      { tool: 'check_action_idempotency', ok: true, result: {} },
      { tool: 'check_user_override', ok: true, result: {} },
    ],
    rationale: 'within caps, not a duplicate, user allows',
  },
  runMetrics: { ...metrics, agentName: 'reviewer' as const },
}));

const runExecutor = vi.fn(async () => ({ ok: true, detail: {} }));
vi.mock('../agents/drafter.js', () => ({ runDrafter: () => runDrafter() }));
vi.mock('../agents/reviewer.js', () => ({ runReviewer: () => runReviewer() }));
vi.mock('../services/executor.js', () => ({ runExecutor: () => runExecutor() }));

let familyTier: PlanTier = 'free';
const recordEntitlementGate = vi.fn(async () => {});
const recordExecution = vi.fn(async () => {});

vi.mock('../services/memory-writer.js', () => ({
  loadResumePoint: vi.fn(async () => null),
  recordEvent: vi.fn(async () => ({ eventId: 'evt-1', duplicate: false })),
  recordAction: vi.fn(async () => ({ actionId: 'action-1', drafterRunId: 'run-1' })),
  recordReviewerVerdict: vi.fn(async () => {}),
  recordReviewerRejection: vi.fn(async () => {}),
  recordEntitlementGate: (...args: unknown[]) => recordEntitlementGate(...(args as [])),
  recordExecution: (...args: unknown[]) => recordExecution(...(args as [])),
  recordDrop: vi.fn(async () => {}),
  recordActionGate: vi.fn(async () => {}),
  markEventStage: vi.fn(async () => {}),
  loadActionForEvent: vi.fn(async () => null),
  loadFamilyPlanTier: vi.fn(async () => familyTier),
  // Fix-wave B gates: clear them all so the entitlement gate is the only brake
  // under test — old family, full streak, single-parent, newborn stage.
  loadFamilyCreatedAt: vi.fn(async () => new Date('2020-01-01T00:00:00.000Z')),
  loadActionApprovalHistory: vi.fn(async () =>
    Array.from({ length: 5 }, () => ({ actionType: 'place_supply_order', humanApproved: true })),
  ),
  loadCrossParentConsent: vi.fn(async () => ({
    hasCoParent: false,
    coParentConsentGranted: false,
  })),
  loadChildStages: vi.fn(async () => ['newborn']),
}));

const { runOrchestrator } = await import('./index.js');

const job: IngestedEventPayload = {
  family_id: 'fam-1',
  source: 'stripe',
  payload: { item: 'diapers' },
  received_at: '2026-06-12T10:00:00.000Z',
};

describe('runOrchestrator — B18 entitlement gate', () => {
  beforeEach(() => {
    recordEntitlementGate.mockClear();
    recordExecution.mockClear();
    runExecutor.mockClear();
  });

  it('free tier + L3-eligible commerce action → gated to drafted_for_approval, never executed', async () => {
    familyTier = 'free';
    await runOrchestrator(job);

    expect(recordEntitlementGate).toHaveBeenCalledTimes(1);
    expect(recordEntitlementGate).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'fam-1',
        actionId: 'action-1',
        actionType: 'place_supply_order',
        planTier: 'free',
        requiredEntitlement: 'autonomy_l3',
      }),
    );
    expect(runExecutor).not.toHaveBeenCalled();
    expect(recordExecution).not.toHaveBeenCalled();
  });

  it('plus tier + commerce action → still gated (commerce needs family tier)', async () => {
    familyTier = 'plus';
    await runOrchestrator(job);

    expect(recordEntitlementGate).toHaveBeenCalledTimes(1);
    expect(recordEntitlementGate).toHaveBeenCalledWith(
      expect.objectContaining({ planTier: 'plus', requiredEntitlement: 'commerce' }),
    );
    expect(runExecutor).not.toHaveBeenCalled();
  });

  it('family tier + commerce action → passes the gate and executes autonomously', async () => {
    familyTier = 'family';
    await runOrchestrator(job);

    expect(recordEntitlementGate).not.toHaveBeenCalled();
    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(recordExecution).toHaveBeenCalledTimes(1);
  });
});
