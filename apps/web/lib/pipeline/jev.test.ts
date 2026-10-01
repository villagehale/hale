import { describe, expect, it, vi } from 'vitest';
import { evaluateJevChoice } from './jev';

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
