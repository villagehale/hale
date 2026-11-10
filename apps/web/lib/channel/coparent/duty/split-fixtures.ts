import { SONNET_MODEL, estimateCostUsd } from '@hale/agent';
import type { SplitDutyRead } from './split-read';

/**
 * VIL-661 eval set. Three cases: a split, one parent takes both, and no answer.
 * Slot accuracy is measured in split-read.eval.test.ts. Paid evals are not run
 * from this tree; {@link estimateSplitDutyEvalCostUsd} is the dry-run ceiling.
 */

export const SPLIT_DUTY_ACCURACY_FLOOR = 1;

export interface SplitDutyFixture {
  id: 'split' | 'takes-both' | 'no-answer';
  text: string;
  llm: {
    kind: SplitDutyRead['kind'];
    confidence: number;
    assignments: Array<{
      eventKey: string;
      kid: string | null;
      claim: 'self' | 'other_parent' | 'named';
      name: string | null;
      confidence: number;
    }>;
  };
  expect: {
    write: boolean;
    kind: SplitDutyRead['kind'];
    owners: Record<string, string | null>;
  };
}

export const SPLIT_DUTY_EVENTS = [
  { eventKey: 'hockey', role: 'attend' as const, kid: 'Maya', label: 'hockey' },
  { eventKey: 'dance', role: 'attend' as const, kid: 'Leo', label: 'dance' },
] as const;

export const SPLIT_DUTY_PARENTS = [
  { userId: 'ana', name: 'Ana' },
  { userId: 'sam', name: 'Sam' },
] as const;

export const SPLIT_DUTY_FIXTURES: readonly SplitDutyFixture[] = [
  {
    id: 'split',
    text: "I'll take Maya to hockey, you take Leo to dance",
    llm: {
      kind: 'split',
      confidence: 0.9,
      assignments: [
        { eventKey: 'hockey', kid: 'Maya', claim: 'self', name: null, confidence: 0.9 },
        { eventKey: 'dance', kid: 'Leo', claim: 'other_parent', name: 'Sam', confidence: 0.9 },
      ],
    },
    expect: {
      write: true,
      kind: 'split',
      owners: { hockey: 'ana', dance: 'sam' },
    },
  },
  {
    id: 'takes-both',
    text: "actually I'll take both",
    llm: {
      kind: 'change_of_mind',
      confidence: 0.88,
      assignments: [
        { eventKey: 'hockey', kid: 'Maya', claim: 'self', name: null, confidence: 0.88 },
        { eventKey: 'dance', kid: 'Leo', claim: 'self', name: null, confidence: 0.88 },
      ],
    },
    expect: {
      write: true,
      kind: 'change_of_mind',
      owners: { hockey: 'ana', dance: 'ana' },
    },
  },
  {
    id: 'no-answer',
    text: 'thanks, we will figure it out',
    llm: {
      kind: 'none',
      confidence: 0.3,
      assignments: [],
    },
    expect: {
      write: false,
      kind: 'none',
      owners: { hockey: null, dance: null },
    },
  },
];

/**
 * Dry-run cost for the three fixtures: one extract-split-duty call and one
 * reply-copy voice call each, on Sonnet. Generous token pads; still well
 * under $5. This does not call a model.
 */
export function estimateSplitDutyEvalCostUsd(): {
  usd: number;
  ceilingUsd: number;
  calls: number;
} {
  const extract = estimateCostUsd(SONNET_MODEL, {
    inputTokens: 2_000,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 250,
  });
  const voice = estimateCostUsd(SONNET_MODEL, {
    inputTokens: 2_500,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 180,
  });
  const perCase = extract + voice;
  return {
    usd: perCase * SPLIT_DUTY_FIXTURES.length,
    ceilingUsd: 5,
    calls: SPLIT_DUTY_FIXTURES.length * 2,
  };
}
