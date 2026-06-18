import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestedEventPayload } from '@hale/tools-contracts';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import type { ClassifierSuggestion } from '@hale/types';

/**
 * FIX 1 — an approved, autonomy-qualified action that crashes in the execute
 * window must NOT be silently dropped on redelivery. The pre-execute checkpoint
 * is its own status ('approved_pending_execute'); a redelivery sees it as a
 * RESUMABLE (not terminal) state and re-drives the executor exactly once, then
 * advances the event to 'actioned'. We mock the agents + memory-writer over a
 * shared in-memory event store and count runExecutor invocations across passes.
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

interface StoredEvent {
  eventId: string;
  status: string;
  eventType: string;
  payload: Record<string, unknown>;
  classifierConfidence: number;
  suggestion: ClassifierSuggestion | null;
}
const store = new Map<string, StoredEvent>();

const runClassifier = vi.fn(async () => ({
  eventType: 'pediatric_appointment_request',
  payload: { foo: 'bar' },
  confidence: { score: 0.95, rationale: 'sure' },
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
    payload: { to: 'a@b.com', subject: 'hi', body: 'hello' },
    draftConfidence: 0.95,
    rationale: 'x',
    recipientVisibility: 'public' as const,
    draftedAt: '2026-06-12T10:00:00.000Z',
  },
  runMetrics: { ...metrics, agentName: 'drafter' as const },
}));

// Approve WITH full coverage so the only remaining brake is the autonomy path.
const runReviewer = vi.fn(async () => ({
  verdict: {
    kind: 'approve' as const,
    toolResults: [
      { tool: 'check_pii_leak', ok: true, result: {} },
      { tool: 'check_recipient_allowlist', ok: true, result: {} },
      { tool: 'check_action_idempotency', ok: true, result: {} },
    ],
    rationale: 'all green',
  },
  runMetrics: { ...metrics, agentName: 'reviewer' as const },
}));

const runExecutor = vi.fn(async () => ({ ok: true, detail: { kind: 'email_sent' } }));
vi.mock('../agents/drafter.js', () => ({ runDrafter: () => runDrafter() }));
vi.mock('../agents/reviewer.js', () => ({ runReviewer: () => runReviewer() }));
vi.mock('../services/executor.js', () => ({ runExecutor: () => runExecutor() }));

// Crash flag — flips on to simulate a kill right after the pre-execute checkpoint.
let crashAfterApprovedPending = false;

vi.mock('../services/memory-writer.js', () => ({
  loadResumePoint: vi.fn(async (_fam: string, hash: string) => store.get(hash) ?? null),
  recordEvent: vi.fn(async (input: StoredEvent & { dedupHash: string }) => {
    store.set(input.dedupHash, {
      eventId: 'evt-1',
      status: 'classified',
      eventType: input.eventType,
      payload: input.payload,
      classifierConfidence: input.classifierConfidence,
      suggestion: input.suggestion,
    });
    return { eventId: 'evt-1', duplicate: false };
  }),
  recordAction: vi.fn(async () => ({ actionId: 'action-1', drafterRunId: 'run-1' })),
  recordReviewerVerdict: vi.fn(async () => {}),
  recordReviewerRejection: vi.fn(async () => {}),
  recordExecution: vi.fn(async () => {}),
  recordEntitlementGate: vi.fn(async () => {}),
  recordDrop: vi.fn(async () => {}),
  markEventStage: vi.fn(async (_fam: string, _evt: string, stage: string) => {
    const ev = store.get('fixed-hash');
    if (ev) ev.status = stage;
    if (stage === 'approved_pending_execute' && crashAfterApprovedPending) {
      throw new Error('injected crash after approved_pending_execute');
    }
  }),
  loadActionForEvent: vi.fn(async () => ({
    actionId: 'action-1',
    actionType: 'send_email',
    payload: { to: 'a@b.com', subject: 'hi', body: 'hello' },
  })),
  loadApprovedVerdictForAction: vi.fn(async () => ({
    kind: 'approve' as const,
    toolResults: [
      { tool: 'check_pii_leak', ok: true, result: {} },
      { tool: 'check_recipient_allowlist', ok: true, result: {} },
      { tool: 'check_action_idempotency', ok: true, result: {} },
    ],
    rationale: 'all green',
  })),
  loadFamilyPlanTier: vi.fn(async () => 'family' as const),
  loadFamilyMonthToDateCostUsd: vi.fn(async () => 0),
  recordActionGate: vi.fn(async () => {}),
  // Fix-wave B gates all cleared so the FIX 1 resume path still executes:
  // old family, full send_email streak, single-parent, newborn stage.
  loadFamilyCreatedAt: vi.fn(async () => new Date('2020-01-01T00:00:00.000Z')),
  loadActionApprovalHistory: vi.fn(async () =>
    Array.from({ length: 5 }, () => ({ actionType: 'send_email', humanApproved: true })),
  ),
  loadCrossParentConsent: vi.fn(async () => ({
    hasCoParent: false,
    coParentConsentGranted: false,
  })),
  getMemorySlice: vi.fn(async () => ({ facts: [], episodes: [] })),
  loadFamilyContext: vi.fn(async () => ({
    stages: ['newborn'],
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

describe('runOrchestrator — FIX 1 approved-pre-execute crash-resume', () => {
  beforeEach(() => {
    store.clear();
    runClassifier.mockClear();
    runDrafter.mockClear();
    runReviewer.mockClear();
    runExecutor.mockClear();
    crashAfterApprovedPending = false;
  });

  it('re-drives the executor exactly once when the worker crashes after the approved_pending_execute checkpoint', async () => {
    // Pass 1: approve + autonomy-qualify, checkpoint at approved_pending_execute,
    // then crash BEFORE the executor send.
    crashAfterApprovedPending = true;
    await expect(runOrchestrator(job)).rejects.toThrow(
      'injected crash after approved_pending_execute',
    );
    expect(runExecutor).not.toHaveBeenCalled();
    expect(store.get('fixed-hash')?.status).toBe('approved_pending_execute');

    // Clear the agent spies so the next assertions reflect ONLY the resume pass.
    runClassifier.mockClear();
    runDrafter.mockClear();
    runReviewer.mockClear();

    // Pass 2: pg-boss redelivers. approved_pending_execute is RESUMABLE — the
    // orchestrator must re-drive runExecutor straight away (no re-classify,
    // re-draft, or re-review), not short-circuit it as a terminal status.
    crashAfterApprovedPending = false;
    await runOrchestrator(job);

    expect(runExecutor).toHaveBeenCalledTimes(1);
    expect(runClassifier).not.toHaveBeenCalled();
    expect(runDrafter).not.toHaveBeenCalled();
    expect(runReviewer).not.toHaveBeenCalled();
    expect(store.get('fixed-hash')?.status).toBe('actioned');
  });
});
