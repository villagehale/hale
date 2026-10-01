import type { AgentClient } from '@hale/agent';
import { describe, expect, it, vi } from 'vitest';
import { applyVerbatimGuard, createReplyIntentReader } from './intent';

function currentClient(): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'intent',
            input: {
              intent: 'decline',
              verbatim: 'no thanks',
              rationale: 'clear decline',
              confidence: 0.9,
            },
          },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 5 },
      })),
    },
  } as unknown as AgentClient;
}

describe('applyVerbatimGuard', () => {
  it('passes a reading through untouched when the reply was echoed exactly', () => {
    const reading = {
      intent: 'assent' as const,
      verbatim: 'yes please',
      interpretation: 'a yes',
    };
    expect(applyVerbatimGuard(reading, 'yes please')).toBe(reading);
  });

  it('collapses an ASSENT to ambiguous when the echo does not match', () => {
    // A model that paraphrased did not read the reply it was given, so its verdict is
    // not evidence — and the direction that must never survive is a false yes.
    const guarded = applyVerbatimGuard(
      { intent: 'assent', verbatim: 'Yes.', interpretation: 'a yes' },
      'yes please',
    );
    expect(guarded.intent).toBe('ambiguous');
    expect(guarded.verbatim).toBe('yes please');
  });

  it('keeps the parent’s real words on the record even when the reading is discarded', () => {
    const guarded = applyVerbatimGuard(
      { intent: 'decline', verbatim: 'no', interpretation: 'a no' },
      "  no thanks, we're good  ",
    );
    expect(guarded.verbatim).toBe("  no thanks, we're good  ");
    expect(guarded.interpretation).toContain('verbatim mismatch');
  });
});

describe('createReplyIntentReader rollout', () => {
  it('uses JEV by default', async () => {
    const client = currentClient();
    const evaluateChoice = vi.fn(async () => ({
      choice: 'assent' as const,
      probabilities: { assent: 0.9 },
      confidence: 0.8,
      usage: { inputTokens: 10, outputTokens: 1 },
    }));

    const result = await createReplyIntentReader(client, {
      evaluateChoice,
    }).read({ question: 'Want me to watch this?', reply: 'yes please' });

    expect(result).toEqual({
      intent: 'assent',
      verbatim: 'yes please',
      interpretation: 'JEV choice: assent',
    });
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('falls back to the current model when JEV fails', async () => {
    const client = currentClient();
    const result = await createReplyIntentReader(client, {
      modelMode: 'candidate',
      evaluateChoice: vi.fn(async () => {
        throw new Error('candidate unavailable');
      }),
    }).read({ question: 'Want me to watch this?', reply: 'no thanks' });

    expect(result.intent).toBe('decline');
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });

  it('uses Sonnet 5 when current mode is explicit', async () => {
    const client = currentClient();
    const evaluateChoice = vi.fn();

    const result = await createReplyIntentReader(client, {
      modelMode: 'current',
      evaluateChoice,
    }).read({ question: 'Want me to watch this?', reply: 'no thanks' });

    expect(result.intent).toBe('decline');
    expect(evaluateChoice).not.toHaveBeenCalled();
    expect(client.messages.create).toHaveBeenCalledTimes(1);
  });
});
