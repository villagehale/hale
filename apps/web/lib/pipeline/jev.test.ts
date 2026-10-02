import { describe, expect, it, vi } from 'vitest';
import { evaluateJevChoice, meetsJevConfidence } from './jev';

describe('evaluateJevChoice', () => {
  it('returns a validated choice and provider confidence', async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        answers: {
          intent: { choice: 'yes', probabilities: { yes: 0.9, no: 0.1 } },
        },
        usage: { inputTokens: 12, outputTokens: 1 },
        providerMetadata: { typesafe: { confidence: { intent: 0.8 } } },
      }),
    );

    await expect(
      evaluateJevChoice(
        {
          state: { reply: 'yes' },
          question: 'intent',
          instructions: 'Classify the reply.',
          criteria: { yes: 'Yes.', no: 'No.' },
        },
        { apiKey: 'test', fetch },
      ),
    ).resolves.toEqual({
      choice: 'yes',
      probabilities: { yes: 0.9, no: 0.1 },
      confidence: 0.8,
      usage: { inputTokens: 12, outputTokens: 1 },
    });
  });
});

describe('meetsJevConfidence', () => {
  const result = (yes: number, no: number) => ({
    choice: 'yes' as const,
    probabilities: { yes, no },
    confidence: null,
    usage: { inputTokens: 0, outputTokens: 0 },
  });

  it('requires both a high selected probability and a clear margin', () => {
    expect(meetsJevConfidence(result(0.9, 0.1))).toBe(true);
    expect(meetsJevConfidence(result(0.75, 0.25))).toBe(false);
    expect(meetsJevConfidence(result(0.8, 0.3))).toBe(true);
  });
});
