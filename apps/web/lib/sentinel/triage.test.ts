import type { AgentClient } from '@hale/agent';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { triageEmail } from './triage';

function client(childRelated: boolean): AgentClient {
  return {
    messages: {
      create: vi.fn(async () => ({
        content: [
          {
            type: 'tool_use',
            id: 'tool_1',
            name: 'triage',
            input: {
              child_related: childRelated,
              confidence: 0.9,
              rationale: 'fixture',
            },
          },
        ],
        stop_reason: 'tool_use',
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
        },
      })),
    },
  } as unknown as AgentClient;
}

const envelope = {
  subject: 'Mia swim registration confirmed',
  from: 'school@example.com',
  snippet: 'Her first class is Tuesday at 4:30pm',
};

describe('triageEmail rollout', () => {
  beforeEach(() => vi.stubEnv('HALE_TRIAGE_MODEL_MODE', ''));
  afterEach(() => vi.unstubAllEnvs());

  it('keeps Haiku by default', async () => {
    const currentClient = client(false);
    const evaluateChoice = vi.fn(async () => ({
      choice: 'yes' as const,
      probabilities: { yes: 0.95, no: 0.05 },
      confidence: 0.9,
      usage: { inputTokens: 20, outputTokens: 1 },
    }));

    const result = await triageEmail(envelope, ['Mia'], currentClient, {
      evaluateChoice,
    });

    expect(result.childRelated).toBe(false);
    expect(evaluateChoice).not.toHaveBeenCalled();
    expect(currentClient.messages.create).toHaveBeenCalledTimes(1);
  });

  it('falls back to Haiku when JEV fails', async () => {
    const currentClient = client(false);
    const result = await triageEmail(envelope, ['Mia'], currentClient, {
      modelMode: 'candidate',
      evaluateChoice: vi.fn(async () => {
        throw new Error('candidate unavailable');
      }),
    });

    expect(result.childRelated).toBe(false);
    expect(currentClient.messages.create).toHaveBeenCalledTimes(1);
  });

  it('falls back to Haiku before dropping a low-confidence no', async () => {
    const currentClient = client(true);
    const result = await triageEmail(envelope, ['Mia'], currentClient, {
      modelMode: 'candidate',
      evaluateChoice: vi.fn(async () => ({
        choice: 'no' as const,
        probabilities: { yes: 0.35, no: 0.65 },
        confidence: 0.65,
        usage: { inputTokens: 20, outputTokens: 1 },
      })),
    });

    expect(result.childRelated).toBe(true);
    expect(currentClient.messages.create).toHaveBeenCalledTimes(1);
  });

  it('accepts a high-confidence no without calling Haiku', async () => {
    const currentClient = client(true);
    const result = await triageEmail(envelope, ['Mia'], currentClient, {
      modelMode: 'candidate',
      evaluateChoice: vi.fn(async () => ({
        choice: 'no' as const,
        probabilities: { yes: 0.02, no: 0.98 },
        confidence: 0.98,
        usage: { inputTokens: 20, outputTokens: 1 },
      })),
    });

    expect(result.childRelated).toBe(false);
    expect(currentClient.messages.create).not.toHaveBeenCalled();
  });

  it('uses Haiku when current mode is explicit', async () => {
    const currentClient = client(false);
    const result = await triageEmail(envelope, ['Mia'], currentClient, {
      modelMode: 'current',
    });

    expect(result.childRelated).toBe(false);
    expect(currentClient.messages.create).toHaveBeenCalledTimes(1);
  });
});
