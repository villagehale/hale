import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestedEventPayload } from '@hale/tools-contracts';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import type { ClassifierSuggestion } from '@hale/types';

/**
 * B10 — crash-resume re-entrancy. The invariant: a job killed after the
 * classify checkpoint, then redelivered, must NOT re-run the (billable)
 * classifier — it loads the stored classification instead. We mock the agent +
 * memory-writer modules over a shared in-memory event store and count
 * classifier invocations across both passes.
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

// In-memory event store shared by the mocked memory-writer functions.
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
    draftConfidence: 0.95,
    rationale: 'x',
    recipientVisibility: 'public' as const,
    draftedAt: '2026-06-12T10:00:00.000Z',
  },
  runMetrics: { ...metrics, agentName: 'drafter' as const },
}));
const runReviewer = vi.fn(async () => ({
  verdict: { kind: 'flag_for_human' as const, toolResults: [], rationale: 'stop here' },
  runMetrics: { ...metrics, agentName: 'reviewer' as const },
}));
vi.mock('../agents/drafter.js', () => ({ runDrafter: () => runDrafter() }));
vi.mock('../agents/reviewer.js', () => ({ runReviewer: () => runReviewer() }));
vi.mock('../services/executor.js', () => ({ runExecutor: vi.fn() }));

// Injected failure flag — flips on to simulate a crash right after classify.
let crashAfterClassify = false;

vi.mock('../services/memory-writer.js', () => ({
  getMemorySlice: vi.fn(async () => ({ facts: [], episodes: [] })),
  loadFamilyContext: vi.fn(async () => ({
    stages: ['newborn'],
    children: [],
    contextSlice: { childrenAgesMonths: [], province: 'ON', timezone: 'America/Toronto' },
  })),
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
    if (crashAfterClassify) {
      throw new Error('injected crash after classify');
    }
    return { eventId: 'evt-1', duplicate: false };
  }),
  recordAction: vi.fn(async () => ({ actionId: 'action-1', drafterRunId: 'run-1' })),
  recordReviewerVerdict: vi.fn(async () => {}),
  recordReviewerRejection: vi.fn(async () => {}),
  recordExecution: vi.fn(async () => {}),
  recordDrop: vi.fn(async () => {}),
  markEventStage: vi.fn(async (_fam: string, _evt: string, stage: string) => {
    const ev = store.get('fixed-hash');
    if (ev) ev.status = stage;
  }),
  loadActionForEvent: vi.fn(async () => null),
}));

// Imported AFTER the mocks are registered.
const { runOrchestrator } = await import('./index.js');

const job: IngestedEventPayload = {
  family_id: 'fam-1',
  source: 'gmail',
  payload: { messageId: 'm1' },
  received_at: '2026-06-12T10:00:00.000Z',
};

describe('runOrchestrator — B10 crash-resume', () => {
  beforeEach(() => {
    store.clear();
    runClassifier.mockClear();
    runDrafter.mockClear();
    runReviewer.mockClear();
    crashAfterClassify = false;
  });

  it('classifies exactly once across a crash-after-classify + redelivery', async () => {
    // Pass 1: classify runs, event is stored, then a crash is injected before
    // any downstream stage (recordEvent throws after persisting).
    crashAfterClassify = true;
    await expect(runOrchestrator(job)).rejects.toThrow('injected crash after classify');
    expect(runClassifier).toHaveBeenCalledTimes(1);
    expect(store.get('fixed-hash')?.status).toBe('classified');

    // Pass 2: pg-boss redelivers. The stored classification is loaded; the
    // classifier must NOT fire again.
    crashAfterClassify = false;
    await runOrchestrator(job);

    expect(runClassifier).toHaveBeenCalledTimes(1);
    expect(runDrafter).toHaveBeenCalledTimes(1);
  });
});
