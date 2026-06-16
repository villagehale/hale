import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestedEventPayload } from '@hale/tools-contracts';
import type { ActionType } from '@hale/types';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import type { ExecuteApprovedDeps } from './index.js';

/**
 * End-to-end coverage for the village-accept routing fix. The accept flow
 * (apps/web/lib/village/accept.ts) enqueues an events.ingested job with
 * source='village' + payload.event_type='activity_signup_open', EXPECTING the
 * spine to draft → review → route it to a drafted_for_approval add_to_routine
 * action. The LLM classifier is never instructed to emit add_to_routine, so the
 * orchestrator short-circuits it for accepted village items: a deterministic
 * add_to_routine suggestion is injected, then the REAL spine runs (deterministic
 * draft → reviewer → autonomy gates → drafted_for_approval).
 *
 * These are ROUTING tests: the agents are mocked to isolate the deterministic
 * spine. The village leg invokes NO LLM at all — we assert the classifier and
 * drafter never fire — and the reviewer mock returns add_to_routine's REAL
 * REQUIRED_CHECK coverage (check_action_idempotency ok:true) so the unmocked
 * coverage predicate + mintApprovedAction invariants (hard rules #3/#7) execute.
 */

const metrics: AgentRunMetrics = {
  agentName: 'classifier',
  modelUsed: 'claude-haiku-4-5',
  promptTokens: 10,
  completionTokens: 5,
  costUsd: 0.0001,
  latencyMs: 1,
};

// add_to_routine's only REQUIRED_CHECK is check_action_idempotency (a real,
// satisfiable tool). The reviewer mock returns exactly that coverage, ok:true.
const ADD_TO_ROUTINE_VERDICT = {
  kind: 'approve' as const,
  rationale: 'idempotent routine pin — green',
  toolResults: [{ tool: 'check_action_idempotency', ok: true, result: { duplicate: false } }],
};

const runClassifier = vi.fn();
vi.mock('../agents/classifier.js', () => ({ runClassifier: (...a: unknown[]) => runClassifier(...a) }));
vi.mock('../agents/dedup.js', () => ({ dedupHashFor: () => 'village-hash' }));

const runDrafter = vi.fn();
vi.mock('../agents/drafter.js', () => ({ runDrafter: (...a: unknown[]) => runDrafter(...a) }));

const runReviewer = vi.fn(async () => ({
  verdict: ADD_TO_ROUTINE_VERDICT,
  runMetrics: { ...metrics, agentName: 'reviewer' as const },
}));
vi.mock('../agents/reviewer.js', () => ({ runReviewer: () => runReviewer() }));

const runExecutor = vi.fn(async () => ({ ok: true, detail: { kind: 'routine_pin' } }));
vi.mock('../services/executor.js', () => ({ runExecutor: () => runExecutor() }));

const recordAction = vi.fn(
  async (_input: { actionType: ActionType; payload: Record<string, unknown> }) => ({
    actionId: 'action-1',
    drafterRunId: null,
  }),
);
const recordActionGate = vi.fn(async () => {});

// New family → inside the 7-day observe window, so an accepted village item is
// HELD at its drafted_for_approval default rather than auto-executed (autonomy
// not earned), which is exactly the accept-flow contract.
const familyCreatedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

vi.mock('../services/memory-writer.js', () => ({
  loadResumePoint: vi.fn(async () => null),
  recordEvent: vi.fn(async () => ({ eventId: 'evt-1', duplicate: false })),
  recordAction: (input: Parameters<typeof recordAction>[0]) => recordAction(input),
  recordReviewerVerdict: vi.fn(async () => {}),
  recordReviewerRejection: vi.fn(async () => {}),
  recordEntitlementGate: vi.fn(async () => {}),
  recordActionGate: (...a: unknown[]) => recordActionGate(...(a as [])),
  recordExecution: vi.fn(async () => {}),
  recordDrop: vi.fn(async () => {}),
  markEventStage: vi.fn(async () => {}),
  loadActionForEvent: vi.fn(async () => null),
  loadFamilyPlanTier: vi.fn(async () => 'family' as const),
  loadFamilyMonthToDateCostUsd: vi.fn(async () => 0),
  loadFamilyCreatedAt: vi.fn(async () => familyCreatedAt),
  loadActionApprovalHistory: vi.fn(async () => []),
  loadCrossParentConsent: vi.fn(async () => ({ hasCoParent: false, coParentConsentGranted: false })),
  loadFamilyContext: vi.fn(async () => ({
    stages: ['newborn'],
    children: [],
    contextSlice: { childrenAgesMonths: [], province: 'ON', timezone: 'America/Toronto' },
  })),
}));

const { runOrchestrator, executeApprovedAction } = await import('./index.js');

const villageJob: IngestedEventPayload = {
  family_id: '11111111-1111-4111-8111-111111111111',
  source: 'village',
  payload: {
    event_type: 'activity_signup_open',
    candidate_id: 'cand-1',
    title: 'Saturday baby sensory playgroup',
    kind: 'playgroup',
    summary: 'Drop-in sensory play for 0–12mo, serves your area.',
    source_url: 'https://example.ca/playgroup',
    coverage_note: 'serves your area',
  },
  received_at: '2026-06-12T10:00:00.000Z',
};

describe('runOrchestrator — accepted village item routes to add_to_routine', () => {
  beforeEach(() => {
    runClassifier.mockClear();
    runDrafter.mockClear();
    runReviewer.mockClear();
    runExecutor.mockClear();
    recordAction.mockClear();
    recordActionGate.mockClear();
  });

  it('short-circuits the classifier + drafter and yields a drafted_for_approval add_to_routine action', async () => {
    await runOrchestrator(villageJob);

    // The hard-known intent never touches the probabilistic classifier or the
    // drafter LLM — both are skipped.
    expect(runClassifier).not.toHaveBeenCalled();
    expect(runDrafter).not.toHaveBeenCalled();

    // The deterministic draft is the add_to_routine action, recorded (default
    // user_visible_state = drafted_for_approval) and carrying the accepted
    // candidate's coarse fields.
    expect(recordAction).toHaveBeenCalledTimes(1);
    const recordArg = recordAction.mock.calls[0]?.[0];
    expect(recordArg?.actionType).toBe('add_to_routine');
    expect(recordArg?.payload).toMatchObject({
      candidate_id: 'cand-1',
      title: 'Saturday baby sensory playgroup',
    });

    // It still went through the reviewer (hard rule #3) before being routed.
    expect(runReviewer).toHaveBeenCalledTimes(1);

    // Autonomy not earned (new family, inside observe window) → held at
    // drafted_for_approval, never auto-executed.
    expect(runExecutor).not.toHaveBeenCalled();
    expect(recordActionGate).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'observation_window', actionType: 'add_to_routine' }),
    );
  });

  it('the existing approve path then drives that add_to_routine action into execution', async () => {
    const execute = vi.fn(async (..._args: Parameters<ExecuteApprovedDeps['execute']>) => {});
    const deps: ExecuteApprovedDeps = {
      loadAction: vi.fn(async () => ({
        eventId: 'evt-1',
        actionType: 'add_to_routine' as ActionType,
        payload: { candidate_id: 'cand-1', title: 'Saturday baby sensory playgroup' },
        userVisibleState: 'drafted_for_approval',
        verdict: ADD_TO_ROUTINE_VERDICT,
      })),
      loadConsent: vi.fn(async () => ({ hasCoParent: false, coParentConsentGranted: false })),
      recordApproval: vi.fn(async () => {}),
      recordGate: vi.fn(async () => {}),
      execute,
      log: { info: vi.fn(), warn: vi.fn() },
    };

    await executeApprovedAction(
      { actionId: 'action-1', familyId: villageJob.family_id, approvedBy: 'parent-a' },
      deps,
    );

    expect(execute).toHaveBeenCalledTimes(1);
    const approvedArg = execute.mock.calls[0]?.[3];
    expect(approvedArg?.actionType).toBe('add_to_routine');
    expect(approvedArg?.verdict.kind).toBe('approve');
  });
});
