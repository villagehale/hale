import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IngestedEventPayload } from '@hearth/tools-contracts';
import type { AgentRunMetrics } from '../agents/run-metrics.js';
import type { ClassifierSuggestion, FamilyStage } from '@hearth/types';

/**
 * F1 stage-wiring. The invariant: the orchestrator must look up the family's
 * children + dateOfBirth, derive their stages, and PASS them into the classifier
 * BEFORE classification — so a teenager family gets the teenager pack, not the
 * default newborn pack. We capture the argument runClassifier receives and assert
 * the stages match the family's children.
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

// Capture what the orchestrator hands the classifier.
const classifierCalls: Array<{ stages?: FamilyStage[]; familyContextSlice?: unknown }> = [];

const runClassifier = vi.fn(async (input: { stages?: FamilyStage[]; familyContextSlice?: unknown }) => {
  classifierCalls.push({ stages: input.stages, familyContextSlice: input.familyContextSlice });
  return {
    eventType: 'unclassified' as const,
    payload: {},
    confidence: { score: 0.4, rationale: 'low' },
    suggestion,
    teenContent: false,
    dedupHash: 'fixed-hash',
    runMetrics: metrics,
  };
});

vi.mock('../agents/classifier.js', () => ({ runClassifier: (input: unknown) => runClassifier(input as never) }));
vi.mock('../agents/dedup.js', () => ({ dedupHashFor: () => 'fixed-hash' }));
vi.mock('../agents/drafter.js', () => ({ runDrafter: vi.fn() }));
vi.mock('../agents/reviewer.js', () => ({ runReviewer: vi.fn() }));
vi.mock('../services/executor.js', () => ({ runExecutor: vi.fn() }));

// Family fixtures keyed by family id. `loadFamilyContext` resolves stages +
// the classifier context slice from these; the orchestrator must consult it.
const families: Record<
  string,
  {
    stages: FamilyStage[];
    children: Array<{ id: string; name: string; ageInMonths: number }>;
    contextSlice: { childrenAgesMonths: number[]; province: string; timezone: string };
  }
> = {
  'teen-fam': {
    stages: ['teenager'],
    children: [{ id: 'c-teen', name: 'Ava', ageInMonths: 170 }],
    contextSlice: { childrenAgesMonths: [170], province: 'ON', timezone: 'America/Toronto' },
  },
  'no-children-fam': {
    stages: [],
    children: [],
    contextSlice: { childrenAgesMonths: [], province: 'ON', timezone: 'America/Toronto' },
  },
};

const loadFamilyContext = vi.fn(async (familyId: string) => families[familyId]);

vi.mock('../services/memory-writer.js', () => ({
  loadResumePoint: vi.fn(async () => null),
  loadFamilyContext: (familyId: string) => loadFamilyContext(familyId),
  recordEvent: vi.fn(async () => ({ eventId: 'evt-1', duplicate: false })),
  recordDrop: vi.fn(async () => {}),
  // Unused on the surface_only / low-confidence path but referenced at import.
  recordAction: vi.fn(async () => ({ actionId: 'a', drafterRunId: 'r' })),
  recordReviewerVerdict: vi.fn(async () => {}),
  recordReviewerRejection: vi.fn(async () => {}),
  recordExecution: vi.fn(async () => {}),
  recordEntitlementGate: vi.fn(async () => {}),
  recordActionGate: vi.fn(async () => {}),
  recordHumanApproval: vi.fn(async () => {}),
  loadActionForEvent: vi.fn(async () => null),
  loadActionForApproval: vi.fn(async () => null),
  loadApprovedVerdictForAction: vi.fn(async () => null),
  loadFamilyPlanTier: vi.fn(async () => 'free'),
  loadFamilyCreatedAt: vi.fn(async () => new Date('2020-01-01')),
  loadActionApprovalHistory: vi.fn(async () => []),
  loadCrossParentConsent: vi.fn(async () => ({ hasCoParent: false, coParentConsentGranted: false })),
  loadChildStages: vi.fn(async () => []),
  markEventStage: vi.fn(async () => {}),
}));

const { runOrchestrator } = await import('./index.js');

function jobFor(familyId: string): IngestedEventPayload {
  return {
    family_id: familyId,
    source: 'gmail',
    payload: { messageId: 'm1' },
    received_at: '2026-06-12T10:00:00.000Z',
  };
}

describe('runOrchestrator — stage wiring', () => {
  beforeEach(() => {
    classifierCalls.length = 0;
    runClassifier.mockClear();
    loadFamilyContext.mockClear();
  });

  it("passes a teenager family's derived stages + context into the classifier", async () => {
    await runOrchestrator(jobFor('teen-fam'));

    expect(runClassifier).toHaveBeenCalledTimes(1);
    expect(classifierCalls[0]?.stages).toEqual(['teenager']);
    expect(classifierCalls[0]?.familyContextSlice).toEqual({
      childrenAgesMonths: [170],
      province: 'ON',
      timezone: 'America/Toronto',
    });
  });

  it('falls back to ["newborn"] only when the family has no children rows', async () => {
    await runOrchestrator(jobFor('no-children-fam'));

    expect(classifierCalls[0]?.stages).toEqual(['newborn']);
  });
});
