import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestedEventPayload } from '@hale/tools-contracts';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import type { ClassifierSuggestion, FamilyStage } from '@hale/types';

/**
 * HARD monthly LLM-cost ceiling wired into the orchestrator BEFORE the first
 * billable stage (classify). Distinct from the soft over-allowance autonomy valve
 * (that one downgrades autonomy AFTER classify/draft/review have already spent).
 * A family far past its budget must stop costing money entirely: the classifier,
 * drafter, reviewer and executor are NEVER invoked, and a family-scoped
 * event.dropped.spend_ceiling audit is written (hard rule #6).
 *
 * We spy every LLM stage entry and inject the month-to-date cost + plan + child
 * count so the ceiling is the only thing under test.
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

// Injected inputs. Baseline clears every downstream gate so ONLY the ceiling can
// stop the pipeline: old family, full streak, single-parent, newborn.
let monthToDateCostUsd = 0;
let childStages: FamilyStage[] = ['newborn'];

const recordSpendCeilingDrop = vi.fn(async () => {});
const recordExecution = vi.fn(async () => {});

vi.mock('../services/memory-writer.js', () => ({
  loadResumePoint: vi.fn(async () => null),
  recordEvent: vi.fn(async () => ({ eventId: 'evt-1', duplicate: false })),
  recordAction: vi.fn(async () => ({ actionId: 'action-1', drafterRunId: 'run-1' })),
  recordReviewerVerdict: vi.fn(async () => {}),
  recordReviewerRejection: vi.fn(async () => {}),
  recordEntitlementGate: vi.fn(async () => {}),
  recordActionGate: vi.fn(async () => {}),
  recordExecution: (...args: unknown[]) => recordExecution(...(args as [])),
  recordDrop: vi.fn(async () => {}),
  recordSpendCeilingDrop: (...args: unknown[]) => recordSpendCeilingDrop(...(args as [])),
  markEventStage: vi.fn(async () => {}),
  loadActionForEvent: vi.fn(async () => null),
  loadFamilyPlanTier: vi.fn(async () => 'plus' as const),
  loadFamilyMonthToDateCostUsd: vi.fn(async () => monthToDateCostUsd),
  loadFamilyCreatedAt: vi.fn(async () => new Date('2020-01-01T00:00:00.000Z')),
  loadActionApprovalHistory: vi.fn(async () =>
    Array.from({ length: 5 }, () => ({ actionType: 'send_email', humanApproved: true })),
  ),
  loadCrossParentConsent: vi.fn(async () => ({ hasCoParent: false, coParentConsentGranted: false })),
  getMemorySlice: vi.fn(async () => ({ facts: [], episodes: [] })),
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

describe('runOrchestrator — hard monthly LLM-cost ceiling', () => {
  beforeEach(() => {
    runClassifier.mockClear();
    runDrafter.mockClear();
    runReviewer.mockClear();
    runExecutor.mockClear();
    recordSpendCeilingDrop.mockClear();
    recordExecution.mockClear();
    monthToDateCostUsd = 0;
    childStages = ['newborn'];
  });

  it('over the ceiling ($20 spent, plus, 1 child / $15 ceiling) → no LLM stage runs, spend_ceiling audit written', async () => {
    monthToDateCostUsd = 20.0; // > $5 allowance × 3 = $15 ceiling
    childStages = ['newborn'];

    await runOrchestrator(job);

    expect(runClassifier).not.toHaveBeenCalled();
    expect(runDrafter).not.toHaveBeenCalled();
    expect(runReviewer).not.toHaveBeenCalled();
    expect(runExecutor).not.toHaveBeenCalled();
    expect(recordSpendCeilingDrop).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: 'fam-1',
        detail: expect.objectContaining({
          planTier: 'plus',
          childCount: 1,
          monthToDateCostUsd: 20.0,
          ceilingUsd: 15.0,
        }),
      }),
    );
  });

  it('under the ceiling ($8 spent, plus, 1 child / $15 ceiling) → pipeline proceeds, classifier runs, no spend_ceiling audit', async () => {
    monthToDateCostUsd = 8.0; // over the $5 soft allowance but under the $15 hard ceiling
    childStages = ['newborn'];

    await runOrchestrator(job);

    expect(runClassifier).toHaveBeenCalledTimes(1);
    expect(runReviewer).toHaveBeenCalledTimes(1);
    expect(recordSpendCeilingDrop).not.toHaveBeenCalled();
  });

  it('fairness: same $20 spend with a bigger family raises the ceiling and lets the pipeline run', async () => {
    // plus, 6 children → $5 + 5×$3 = $20 allowance → $60 ceiling; $20 is well within.
    monthToDateCostUsd = 20.0;
    childStages = ['newborn', 'newborn', 'newborn', 'toddler', 'child', 'teenager'];

    await runOrchestrator(job);

    expect(runClassifier).toHaveBeenCalledTimes(1);
    expect(recordSpendCeilingDrop).not.toHaveBeenCalled();
  });
});
