import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestedEventPayload } from '@hearth/tools-contracts';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import type { ClassifierSuggestion } from '@hearth/types';

/**
 * FIX 1 (resume gap) — the teen-redaction cap (hard rule #1) must survive a
 * crash-resume. A teen-content event in a teenager family that was approved +
 * autonomy-qualified and checkpointed at 'approved_pending_execute' must STILL
 * be capped on redelivery: the resume path re-applies teenRedactionCapApplies
 * using the persisted teen_content + the family's stages, and the executor is
 * NEVER reached. Before this fix the resume read teen_content as false (never
 * persisted), so an autonomous-eligible teen-content action slipped through.
 *
 * Mirrors approved-execute-resume.test.ts: agents + memory-writer are mocked
 * over a shared in-memory event store; we assert the executor is not called and
 * the gate is audited on the resume pass.
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
  teenContent: boolean;
}
const store = new Map<string, StoredEvent>();

const runClassifier = vi.fn(async () => ({
  eventType: 'pediatric_appointment_request',
  payload: { foo: 'bar' },
  confidence: { score: 0.95, rationale: 'sure' },
  suggestion,
  teenContent: true,
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

const recordActionGate = vi.fn(async () => {});

vi.mock('../services/memory-writer.js', () => ({
  loadResumePoint: vi.fn(async (_fam: string, hash: string) => store.get(hash) ?? null),
  recordEvent: vi.fn(async (input: StoredEvent & { dedupHash: string; teenContent: boolean }) => {
    store.set(input.dedupHash, {
      eventId: 'evt-1',
      status: 'classified',
      eventType: input.eventType,
      payload: input.payload,
      classifierConfidence: input.classifierConfidence,
      suggestion: input.suggestion,
      teenContent: input.teenContent,
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
  recordActionGate: () => recordActionGate(),
  // Every non-teen brake cleared so the ONLY thing that can cap the resume is
  // the teen-redaction cap: old family, full streak, single-parent, AND a
  // teenager in the stages (so teen_content × teenager fires the cap).
  loadFamilyCreatedAt: vi.fn(async () => new Date('2020-01-01T00:00:00.000Z')),
  loadActionApprovalHistory: vi.fn(async () =>
    Array.from({ length: 5 }, () => ({ actionType: 'send_email', humanApproved: true })),
  ),
  loadCrossParentConsent: vi.fn(async () => ({
    hasCoParent: false,
    coParentConsentGranted: false,
  })),
  loadFamilyContext: vi.fn(async () => ({
    stages: ['newborn', 'teenager'],
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

describe('runOrchestrator — FIX 1 teen-content cap survives crash-resume', () => {
  beforeEach(() => {
    store.clear();
    runClassifier.mockClear();
    runDrafter.mockClear();
    runReviewer.mockClear();
    runExecutor.mockClear();
    recordActionGate.mockClear();
  });

  it('re-caps a teen-content event sitting at approved_pending_execute on resume — executor never reached', async () => {
    // A prior pass approved + autonomy-qualified a teen-content action and
    // checkpointed it at 'approved_pending_execute', then the worker crashed
    // before the executor send. The persisted event carries teen_content=true.
    // (Scripted directly: the fresh path caps before reaching this checkpoint,
    // so we seed the checkpoint state a crash-resume must contend with — e.g. a
    // pre-existing checkpoint from before the cap was wired.)
    store.set('fixed-hash', {
      eventId: 'evt-1',
      status: 'approved_pending_execute',
      eventType: 'pediatric_appointment_request',
      payload: { foo: 'bar' },
      classifierConfidence: 0.95,
      suggestion,
      teenContent: true,
    });

    // pg-boss redelivers. The resume reads the persisted teen_content + the
    // teenager stages and re-applies the cap: the executor is NEVER reached, the
    // classifier never re-fires, and the gate is audited as a teen_redaction cap.
    await runOrchestrator(job);

    expect(runExecutor).not.toHaveBeenCalled();
    expect(runClassifier).not.toHaveBeenCalled();
    expect(recordActionGate).toHaveBeenCalledTimes(1);
    expect(store.get('fixed-hash')?.status).toBe('reviewed');
  });
});
