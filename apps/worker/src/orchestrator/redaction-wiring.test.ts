import type { IngestedEventPayload } from '@hale/tools-contracts';
import type { ClassifierSuggestion, FamilyStage } from '@hale/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dedupHashFor } from '../agents/dedup.js';
import type { AgentRunMetrics } from '../agents/run-metrics.js';

/**
 * Rule #1 at the ingest boundary (worker path). Connector/inbound PII must be
 * redacted BEFORE it reaches the classifier — a child's name in the payload is a
 * PLACEHOLDER in what runClassifier sees. The dedup hash, however, is computed on
 * the UN-redacted original so a crash-and-retry still probes to the same row
 * (redaction must not shift the content key).
 *
 * Pure control-flow over mocked agents + memory-writer, with the REAL dedupHashFor
 * so the stability assertion is meaningful (no LLM, no DB).
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

let classifierRawContent: string | null = null;
const runClassifier = vi.fn(async (input: { rawContent: string }) => {
  classifierRawContent = input.rawContent;
  return {
    eventType: 'daycare_communication' as const,
    payload: {},
    confidence: { score: 0.9, rationale: 'sure' },
    suggestion,
    teenContent: false,
    concernsChildId: null,
    dedupHash: dedupHashFor('fam-1', 'gmail', input.rawContent),
    runMetrics: metrics,
  };
});

vi.mock('../agents/classifier.js', () => ({
  runClassifier: (input: { rawContent: string }) => runClassifier(input),
}));
vi.mock('../agents/drafter.js', () => ({ runDrafter: vi.fn() }));
vi.mock('../agents/reviewer.js', () => ({ runReviewer: vi.fn() }));
vi.mock('../services/executor.js', () => ({ runExecutor: vi.fn() }));

const CHILD_NAME = 'Mia';
let recordedDedupHash: string | null = null;

vi.mock('../services/memory-writer.js', () => ({
  loadResumePoint: vi.fn(async () => null),
  getMemorySlice: vi.fn(async () => ({ facts: [], episodes: [] })),
  loadFamilyContext: vi.fn(async () => ({
    stages: ['toddler'] as FamilyStage[],
    children: [{ id: 'c1', name: CHILD_NAME, ageInMonths: 33 }],
    contextSlice: { childrenAgesMonths: [33], province: 'ON', timezone: 'America/Toronto' },
  })),
  recordEvent: vi.fn(async (input: { dedupHash: string }) => {
    recordedDedupHash = input.dedupHash;
    return { eventId: 'evt-1', duplicate: false };
  }),
  recordDrop: vi.fn(async () => {}),
  loadFamilyPlanTier: vi.fn(async () => 'free' as const),
  loadFamilyMonthToDateCostUsd: vi.fn(async () => 0),
  recordSpendCeilingDrop: vi.fn(async () => {}),
}));

const { runOrchestrator } = await import('./index.js');

const job: IngestedEventPayload = {
  family_id: 'fam-1',
  source: 'gmail',
  payload: { subject: 'note', body: `${CHILD_NAME} was picked up at 4pm` },
  received_at: '2026-06-12T10:00:00.000Z',
};

describe('runOrchestrator — redaction at the ingest boundary (rule #1)', () => {
  beforeEach(() => {
    classifierRawContent = null;
    recordedDedupHash = null;
    runClassifier.mockClear();
  });

  it('redacts the child name in what the classifier receives', async () => {
    await runOrchestrator(job);
    expect(classifierRawContent).not.toBeNull();
    expect(classifierRawContent).not.toContain(CHILD_NAME);
    expect(classifierRawContent).toContain('[CHILD]');
  });

  it('computes the dedup hash on the UN-redacted original content', async () => {
    await runOrchestrator(job);
    const originalRaw = JSON.stringify(job.payload);
    expect(recordedDedupHash).toBe(dedupHashFor('fam-1', 'gmail', originalRaw));
    // Sanity: the redacted content would hash differently — proving the stored key
    // is NOT derived from what the classifier saw.
    expect(recordedDedupHash).not.toBe(dedupHashFor('fam-1', 'gmail', classifierRawContent ?? ''));
  });
});
