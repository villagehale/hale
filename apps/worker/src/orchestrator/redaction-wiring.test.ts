import type { IngestedEventPayload } from '@hale/tools-contracts';
import type { ClassifierSuggestion, FamilyStage } from '@hale/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dedupHashFor } from '../agents/dedup.js';
import type { AgentRunMetrics } from '../agents/run-metrics.js';

/**
 * Rule #1 at the ingest boundary (worker path), VIL-160 shape: the orchestrator's
 * job is to hand the classify stage the ORIGINAL payload and the family's real
 * child names. The redaction itself is the stage's own and is asserted at the
 * stage (agents/classifier.test.ts, against a real request) — a mock of
 * runClassifier could only ever witness what this file already decided to pass.
 *
 * The stored dedup hash is computed on the un-redacted original so a
 * crash-and-retry still probes to the same row.
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

type ClassifierInput = { payload: Record<string, unknown>; childNames: readonly string[] };

let classifierInput: ClassifierInput | null = null;
const runClassifier = vi.fn(async (input: ClassifierInput) => {
  classifierInput = input;
  return {
    eventType: 'daycare_communication' as const,
    payload: {},
    confidence: { score: 0.9, rationale: 'sure' },
    suggestion,
    teenContent: false,
    concernsChildId: null,
    dedupHash: dedupHashFor('fam-1', 'gmail', JSON.stringify(input.payload)),
    runMetrics: metrics,
  };
});

vi.mock('../agents/classifier.js', () => ({
  runClassifier: (input: ClassifierInput) => runClassifier(input),
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
    classifierInput = null;
    recordedDedupHash = null;
    runClassifier.mockClear();
  });

  it('hands the classify stage the original payload and the family\'s child names', async () => {
    await runOrchestrator(job);
    // Both halves matter: the stage cannot redact a payload it was not given,
    // and it cannot match a name it was not told. An empty childNames here would
    // pass the type and silently leak the name past the redactor.
    expect(classifierInput?.payload).toEqual(job.payload);
    expect(classifierInput?.childNames).toEqual([CHILD_NAME]);
  });

  it('computes the dedup hash on the UN-redacted original content', async () => {
    await runOrchestrator(job);
    const originalRaw = JSON.stringify(job.payload);
    expect(recordedDedupHash).toBe(dedupHashFor('fam-1', 'gmail', originalRaw));
  });
});
