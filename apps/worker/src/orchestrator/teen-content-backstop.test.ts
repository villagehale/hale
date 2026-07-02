import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestedEventPayload } from '@hale/tools-contracts';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import type { ClassifierSuggestion, FamilyStage } from '@hale/types';

/**
 * Rule #1 write-site backstop. The classifier's teen_content flag is a probabilistic
 * signal; a classify miss must NOT leak a 13+ child's raw content. The stored
 * events.teen_content is the source of truth for the Langfuse mask and the autonomy
 * cap, so the orchestrator must persist `classifierFlag OR (resolved child is a teen
 * by age)`. Here the classifier returns teen_content=false (the miss) but attributes
 * the event to a child the family context marks as a teenager → the persisted flag
 * must come out true.
 *
 * Pure control-flow over mocked agents + memory-writer; no LLM, no DB. We capture
 * the teenContent recordEvent receives.
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

let classifierConcernsChildId: string | null = null;

const runClassifier = vi.fn(async () => ({
  eventType: 'school_communication' as const,
  payload: {},
  confidence: { score: 0.9, rationale: 'sure' },
  suggestion,
  // The classify MISS: the model failed to mark this teen's content.
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

// ageInMonths 170 → teenager (>156mo); the newborn sibling is well below.
const TEEN_CHILD_ID = '11111111-1111-1111-1111-111111111111';
const NEWBORN_CHILD_ID = '22222222-2222-2222-2222-222222222222';

const recordedTeenContent: boolean[] = [];

vi.mock('../services/memory-writer.js', () => ({
  loadResumePoint: vi.fn(async () => null),
  getMemorySlice: vi.fn(async () => ({ facts: [], episodes: [] })),
  loadFamilyContext: vi.fn(async () => ({
    stages: ['teenager', 'newborn'] as FamilyStage[],
    children: [
      { id: TEEN_CHILD_ID, name: 'Ava', ageInMonths: 170 },
      { id: NEWBORN_CHILD_ID, name: 'Noah', ageInMonths: 4 },
    ],
    contextSlice: { childrenAgesMonths: [170, 4], province: 'ON', timezone: 'America/Toronto' },
  })),
  recordEvent: vi.fn(async (input: { teenContent: boolean }) => {
    recordedTeenContent.push(input.teenContent);
    return { eventId: 'evt-1', duplicate: false };
  }),
  recordDrop: vi.fn(async () => {}),
  // Pre-classify hard-ceiling read — under ceiling so the fresh path runs.
  loadFamilyPlanTier: vi.fn(async () => 'free' as const),
  loadFamilyMonthToDateCostUsd: vi.fn(async () => 0),
  recordSpendCeilingDrop: vi.fn(async () => {}),
}));

const { runOrchestrator } = await import('./index.js');

const job: IngestedEventPayload = {
  family_id: 'fam-1',
  source: 'gmail',
  payload: { messageId: 'm1' },
  received_at: '2026-06-12T10:00:00.000Z',
};

describe('runOrchestrator — teen_content write-site backstop (rule #1)', () => {
  beforeEach(() => {
    recordedTeenContent.length = 0;
    runClassifier.mockClear();
  });

  it('persists teen_content=true when the event concerns a teen child even if the classifier missed it', async () => {
    classifierConcernsChildId = TEEN_CHILD_ID;
    await runOrchestrator(job);
    expect(recordedTeenContent).toEqual([true]);
  });

  it('leaves teen_content=false when the concerns-child is not a teen', async () => {
    classifierConcernsChildId = NEWBORN_CHILD_ID;
    await runOrchestrator(job);
    expect(recordedTeenContent).toEqual([false]);
  });

  it('leaves teen_content=false when the event is not attributed to any child', async () => {
    classifierConcernsChildId = null;
    await runOrchestrator(job);
    expect(recordedTeenContent).toEqual([false]);
  });
});
