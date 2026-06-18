import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestedEventPayload } from '@hale/tools-contracts';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import type { ClassifierSuggestion, FamilyStage } from '@hale/types';

/**
 * Child attribution. The invariant the orchestrator enforces deterministically
 * (NOT the LLM's job): the classifier's concerns_child_id is persisted on
 * events.child_id ONLY when it names a real child of THIS family. A hallucinated
 * or stale id is dropped to null rather than written as a dangling reference.
 * Family-wide / undeterminable (classifier returns null) stays null.
 *
 * Pure control-flow over mocked agents + memory-writer; no LLM, no DB. We capture
 * the childId recordEvent receives.
 */

const metrics: AgentRunMetrics = {
  agentName: 'classifier',
  modelUsed: 'claude-haiku-4-5',
  promptTokens: 10,
  completionTokens: 5,
  costUsd: 0.0001,
  latencyMs: 1,
};

const suggestion: ClassifierSuggestion = { kind: 'surface_only' };

// What the (mocked) classifier returns as its attribution id; set per test.
let classifierConcernsChildId: string | null = null;

const runClassifier = vi.fn(async () => ({
  eventType: 'daycare_communication' as const,
  payload: {},
  confidence: { score: 0.9, rationale: 'sure' },
  suggestion,
  teenContent: false,
  concernsChildId: classifierConcernsChildId,
  dedupHash: 'fixed-hash',
  runMetrics: metrics,
}));

vi.mock('../agents/classifier.js', () => ({ runClassifier: () => runClassifier() }));
vi.mock('../agents/dedup.js', () => ({ dedupHashFor: () => 'fixed-hash' }));
vi.mock('../agents/drafter.js', () => ({ runDrafter: vi.fn() }));
vi.mock('../agents/reviewer.js', () => ({ runReviewer: vi.fn() }));
vi.mock('../services/executor.js', () => ({ runExecutor: vi.fn() }));

// The family has two known children; KNOWN_CHILD_ID is one of them.
const KNOWN_CHILD_ID = '11111111-1111-1111-1111-111111111111';
const SIBLING_CHILD_ID = '22222222-2222-2222-2222-222222222222';

const recordedChildIds: Array<string | null> = [];

vi.mock('../services/memory-writer.js', () => ({
  loadResumePoint: vi.fn(async () => null),
  getMemorySlice: vi.fn(async () => ({ facts: [], episodes: [] })),
  loadFamilyContext: vi.fn(async () => ({
    stages: ['toddler', 'newborn'] as FamilyStage[],
    children: [
      { id: KNOWN_CHILD_ID, name: 'Mia', ageInMonths: 33 },
      { id: SIBLING_CHILD_ID, name: 'Noah', ageInMonths: 4 },
    ],
    contextSlice: { childrenAgesMonths: [33, 4], province: 'ON', timezone: 'America/Toronto' },
  })),
  recordEvent: vi.fn(async (input: { childId: string | null }) => {
    recordedChildIds.push(input.childId);
    // surface_only routes to digest only — no downstream record* calls needed.
    return { eventId: 'evt-1', duplicate: false };
  }),
  recordDrop: vi.fn(async () => {}),
}));

const { runOrchestrator } = await import('./index.js');

const job: IngestedEventPayload = {
  family_id: 'fam-1',
  source: 'gmail',
  payload: { messageId: 'm1' },
  received_at: '2026-06-12T10:00:00.000Z',
};

describe('runOrchestrator — child attribution persistence', () => {
  beforeEach(() => {
    recordedChildIds.length = 0;
    runClassifier.mockClear();
  });

  it('persists a real child id the classifier attributed the event to', async () => {
    classifierConcernsChildId = KNOWN_CHILD_ID;
    await runOrchestrator(job);
    expect(recordedChildIds).toEqual([KNOWN_CHILD_ID]);
  });

  it('drops an unknown (hallucinated) child id to null', async () => {
    classifierConcernsChildId = '99999999-9999-9999-9999-999999999999';
    await runOrchestrator(job);
    expect(recordedChildIds).toEqual([null]);
  });

  it('persists null when the classifier could not attribute the event', async () => {
    classifierConcernsChildId = null;
    await runOrchestrator(job);
    expect(recordedChildIds).toEqual([null]);
  });
});
